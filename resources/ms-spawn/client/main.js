"use strict";

// Client script for ms-spawn. Plan docs/architecture-plan-ms-spawn.md §4.3, §8 (CHG-01) and §8b (CHG-02).
// Presentation only: the server owns the destination and the confirm gate. This script
//  - hides the local body while the player chooses (LocalPlayer.setVisibility) and always gives it back,
//  - covers the screen (page event "cover") from every select until the area around the point is loaded, parks the camera at
//    the server-derived departure pose under the cover, then lifts the cover and plays the aerial swoop to the target pose,
//  - covers the screen again after a confirm until the world at the final position is loaded, then fades, restores
//    camera and body and closes the page,
//  - while the player chooses, takes world collision and gravity away (CHG-07: LocalPlayer.setCollision(false) + suspendGravity) so
//    the preview never hurts, and gives them back in the order resetFall, setCollision(true), restoreGravity: on every exit that
//    does not confirm, and on a confirm only at the end of the flow (final world loaded), just before the cover lifts,
//  - always hands the camera and the body back (closed, error, stop, session lost, watchdog).
// The client never computes targets and never receives a spawn point. Page <-> client contract: ui-src/src/bridge.js.
// Controls are owned by ms-character (disabled in its lobby, restored when it reports "playing"): not touched here.

const FLIGHT_POLL_MS = 100;
const ARRIVAL_GRACE_MS = 3000;     // hard cap after the nominal flight duration if Camera.playing never settles
const AREA_POLL_MS = 250;
const SELECT_GAP_MS = 250;         // above the server's 200 ms gap: an honest client never trips the server limit
const RESTORE_SECONDS = 1;         // blend back to the player's own camera after the world entry (Camera transitions are in seconds)
const BODY_RETRY_MS = 250;         // LocalPlayer.setVisibility returns false while there is no pawn yet: retry, bounded
const BODY_RETRY_MAX = 40;         // 10 s
const FINAL_FADE_MS = 250;         // the page fades the cover out in 150 ms; the page closes >= 200 ms after the lift (decision 6)
const CONFIRM_ACK_MS = 5000;       // a confirm the server never answers must not keep the screen covered
const APPLY_MAX_MS = 60000;        // ms-character never reports "closed": do not keep the screen covered forever
const EASINGS = ["linear", "smoothStep", "easeIn", "easeOut", "easeInOut"];
const FAILED_FLIGHT_NOTICE = "Não foi possível sobrevoar este local. Podes confirmar mesmo assim ou escolher outro.";
const CONFIRM_UNANSWERED_NOTICE = "O servidor não respondeu. Tenta confirmar de novo.";
const FAILED_PREPARE_NOTICE = "Não foi possível preparar este local. Tenta de novo ou escolhe outro local.";
const VIEW_URL = "fw://resources/ms-spawn/client/ui/index.html";
const DEFAULT_AREA_TIMEOUT_MS = 15000;

let view = null, pageReady = false;
let locations = new Map();          // id -> { position, rotation, departure } from ms-spawn:open
let pageLocations = null;           // what the page gets: {id, name, kind, icon?} only (icon = a validated file name, CHG-05)
let timingLog = false;              // CHG-03: from ms-spawn:open (boolean, absent = false); the page never receives it
let flightConfig = { durationMs: 1500, easing: "easeInOut" }, areaTimeoutMs = DEFAULT_AREA_TIMEOUT_MS;
let lastState = null, lastCamera = null, coverState = null;
// phase: idle | covering | flying | arrived | failed | confirming | finishing | leaving
let phase = "idle", sel = null, serverStatus = null, counter = 0;
let pollTimer = null, ackTimer = null, applyTimer = null, fadeTimer = null;
let cameraTouched = false;
let lastSelectAt = -Infinity, pendingSelect = null, pendingTimer = null;
let bodyTouched = false, bodyHidden = false, bodyTimer = null, bodyTries = 0;
// CHG-07: movementTouched = this open took (or is taking) collision and gravity and owes the restore; the two flags below say
// which parts are settled so the retry loop never repeats a call (gravity answers true even without a pawn, collision needs one).
let movementTouched = false, gravitySettled = false, collisionSettled = false;

function attempt(label, fn) {
  try { return fn(); } catch (error) {
    if (typeof console !== "undefined" && console.log) console.log("[ms-spawn] " + label + " failed: " + (error && error.message ? error.message : error));
    return undefined;
  }
}
function cancelTimer(timer) { if (timer !== null && timer !== undefined) clearTimeout(timer); return null; }
function sendToPage(name, payload) { if (pageReady && view !== null) Web.emit(view, name, payload); }
// Server events arrive as parsed objects (like ms-character's) or, defensively, as JSON strings.
function parse(value) {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
  return value !== null && typeof value === "object" ? value : null;
}
const finite = value => typeof value === "number" && Number.isFinite(value);
// CHG-05: same rule as the server config (a file name inside icons/); anything else is dropped so the page never builds an odd URL.
const ICON_PATTERN = /^[a-z0-9_-]+\.(png|webp|jpg|jpeg|svg)$/;
const validIcon = value => typeof value === "string" && value.length <= 64 && ICON_PATTERN.test(value);
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 64;
// An unexpected error in any handler ends the whole selection safely (camera, body, page) instead of leaving a cover or a hidden body.
const guarded = (label, fn) => (...args) => {
  try { return fn(...args); } catch (error) {
    if (typeof console !== "undefined" && console.log) console.log("[ms-spawn] " + label + " crashed: " + (error && error.message ? error.message : error));
    // SEC-12: a selection was open (page or locations): give everything back, then tell the server the player is no longer
    // choosing, so ms-character enters at the default spawn instead of leaving the player held with no UI. Idempotent server side.
    const open = view !== null || pageLocations !== null;
    attempt("emergency teardown", () => teardown(0));
    if (open) attempt("abandon", () => Events.emitServer("ms-spawn:abandon", {}));
    return undefined;
  }
};

// ---- Own body (CHG-02) -----------------------------------------------------------------------------------------------

// setVisibility(false) and setCollision(false) return false while there is no pawn: retry on a bounded schedule, never throw.
// CHG-07: the movement part rides the same attempt and the same bounded retry. A call that throws is logged once by attempt()
// and counted as settled (it is not retried), so a broken native never blocks the flow nor floods the log.
function hideBody() {
  bodyTimer = cancelTimer(bodyTimer);
  const movementPending = movementTouched && !(gravitySettled && collisionSettled);
  if (bodyHidden && !movementPending) return;
  bodyTouched = true;
  if (!bodyHidden) {
    const ok = attempt("hideBody", () => LocalPlayer.setVisibility(false));
    if (ok === true) bodyHidden = true;
  }
  if (movementTouched) {
    if (!gravitySettled) { const g = attempt("suspendGravity", () => LocalPlayer.suspendGravity()); if (g !== false) gravitySettled = true; }
    if (!collisionSettled) { const c = attempt("setCollision(false)", () => LocalPlayer.setCollision(false)); if (c !== false) collisionSettled = true; }
  }
  if (bodyHidden && (!movementTouched || (gravitySettled && collisionSettled))) { bodyTries = 0; return; }
  if (++bodyTries >= BODY_RETRY_MAX) {
    bodyTries = 0;
    if (typeof console !== "undefined" && console.log) console.log("[ms-spawn] warning: the local body or collision could not be set (no pawn); continuing");
    return;
  }
  bodyTimer = setTimeout(hideBody, BODY_RETRY_MS);
}
// CHG-07: idempotent, once per open, flag set before acting. Order matters (LocalPlayer.md): resetFall before collision comes back.
// Every call is independent: one that throws never skips the others.
function restoreMovement() {
  if (!movementTouched) return;
  movementTouched = false; gravitySettled = false; collisionSettled = false;
  attempt("resetFall", () => LocalPlayer.resetFall());
  attempt("setCollision(true)", () => LocalPlayer.setCollision(true));
  attempt("restoreGravity", () => LocalPlayer.restoreGravity());
}
// Idempotent: the body is given back once per hide, on every exit.
function restoreBody() {
  bodyTimer = cancelTimer(bodyTimer); bodyTries = 0;
  if (!bodyTouched) return;
  bodyTouched = false; bodyHidden = false;
  attempt("showBody", () => LocalPlayer.setVisibility(true));
}

// ---- Cover (page event "cover") -----------------------------------------------------------------------------------------

// Sent only on change unless forced (the page lifts the cover on its own for any notice, so a client that still waits re-asserts it).
function setCover(visible, moment, force = false) {
  if (!force && coverState && coverState.visible === visible && coverState.moment === moment) return;
  coverState = { visible, moment };
  sendToPage("cover", coverState);
}

// ---- Camera ------------------------------------------------------------------------------------------------------

function validPose(pose) {
  const p = pose && pose.position, r = pose && pose.rotation;
  return Boolean(p && r && finite(p.x) && finite(p.y) && finite(p.z) && finite(r.pitch) && finite(r.yaw) && finite(r.roll));
}
const pose = value => ({ position: value.position, rotation: value.rotation });
function stopPolling() { pollTimer = cancelTimer(pollTimer); ackTimer = cancelTimer(ackTimer); applyTimer = cancelTimer(applyTimer); fadeTimer = cancelTimer(fadeTimer); sel = null; }
// Idempotent. Only touches the camera if this resource took it, and checks Camera.active so it never takes the view
// from another system (restore() always points the view back at the character).
function restoreCamera(duration) {
  if (!cameraTouched) return;
  cameraTouched = false;
  attempt("restoreCamera", () => {
    if (!Camera.active) return;
    Camera.stop();
    Camera.clearLookAt();
    Camera.restore({ duration });
  });
}
function setCamera(status, id) { lastCamera = { status, id }; sendToPage("camera", lastCamera); }

// Area loaded: the world streams around the player, who the server holds at the selected point, so the ground under the
// target pose exists when a vertical World.lineTrace hits. A null result can mean "not loaded yet"
// (docs/arcane-mp/guides/world/line-traces.md). Level and water only. CHG-05 (G19): the probe runs below the camera position
// (the point the server teleported the player to), which may sit well above the ground, so it starts at z+100 and
// reaches 20000 cm down (the documented pattern ended at z-10000).
// UI only: the server decides whether a confirm is accepted and never reads it.
const GROUND_OBJECT_TYPES = ["worldStatic", "shallowWater", "deepWater"];
const PROBE_UP_CM = 100, PROBE_DEPTH_CM = 20000;
function areaLoaded(position) {
  const hit = World.lineTrace({ x: position.x, y: position.y, z: position.z + PROBE_UP_CM }, { x: position.x, y: position.y, z: position.z + PROBE_UP_CM - PROBE_DEPTH_CM }, { objectTypes: GROUND_OBJECT_TYPES });
  return Boolean(hit) && hit.startPenetrating !== true;
}

// CHG-03: one console line per select when the cover lifts or the ceiling hits. Measurement only: nothing here gates anything.
// The last three fields are experimental (semantics of World.isReady/generation and LevelObjects.near are unverified, see
// docs/ms-spawn-runtime-findings.md) and are read inside attempt(), so a throw costs the field, never the selection.
const NEAR_RADIUS_CM = 2000;
function logTiming(f, ceiling) {
  if (!timingLog || f.timingLogged || typeof console === "undefined" || !console.log) return;
  f.timingLogged = true;
  const since = at => (at === null || at === undefined ? "null" : String(at - f.startedAt));
  const experimental = [
    "worldReady=" + attempt("World.isReady", () => World.isReady()),
    "worldGeneration=" + attempt("World.generation", () => World.generation()),
    "nearObjects=" + attempt("LevelObjects.near", () => LevelObjects.near({ radius: NEAR_RADIUS_CM }).length),
  ];
  console.log(`[ms-spawn] timing select=${f.id} toTeleportDoneMs=${since(f.teleportDoneAt)} toGroundHitMs=${since(f.groundHitAt)} toCoverLiftMs=${Date.now() - f.startedAt} ceiling=${ceiling} experimental: ${experimental.join(" ")}`);
}

// ---- Selection: cover, departure pose, area wait, swoop ------------------------------------------------------------------

// Every select (also a re-select of the same id after a failure) restarts here; the cover stays on without toggling and
// the area ceiling restarts. Results of older selections are ignored (token / identity checks).
function beginSelection(id) {
  const target = locations.get(id);
  if (!target) return;
  pollTimer = cancelTimer(pollTimer);
  const f = sel = { id, token: ++counter, startedAt: Date.now(), teleport: null, teleportDoneAt: null, groundHitAt: null, timingLogged: false, seenPlaying: false, arrived: false };
  phase = "covering";
  setCover(true, "choosing");
  // Under the cover: park the camera at the server's departure pose, without animation.
  const placed = attempt("departure", () => {
    cameraTouched = true; // set first: a throw inside activate/setPose must still be undone by restoreCamera
    const departure = pose(target.departure);
    if (!Camera.active) {
      const current = Camera.capture();
      if (!current) return false;
      Camera.clearLookAt();
      return Camera.activate({ ...current, ...departure }, { duration: 0 }) === true;
    }
    Camera.stop(); // a new select cancels a running swoop
    Camera.clearLookAt();
    return Camera.setPose(departure) !== false;
  });
  if (sel !== f) return;
  if (placed !== true) { failCamera(f); return; }
  pollTimer = setTimeout(() => pollCover(f), AREA_POLL_MS);
}
function pollCover(f) {
  if (sel !== f || phase !== "covering") return;
  pollTimer = null;
  const target = locations.get(f.id);
  if (f.teleport === "failed") { failPrepare(f, FAILED_PREPARE_NOTICE); return; }
  const loaded = f.teleport === "done" && target ? attempt("areaLoaded", () => areaLoaded(target.position)) === true : false;
  if (loaded) { f.groundHitAt = Date.now(); lift(f, false); return; }
  if (Date.now() - f.startedAt >= areaTimeoutMs) {
    // Decision 1: the ceiling with the teleport done is not a failure (the probe may simply not detect). Without the teleport result it is.
    if (f.teleport === "done") lift(f, true); else { logTiming(f, true); failPrepare(f, FAILED_PREPARE_NOTICE); }
    return;
  }
  pollTimer = setTimeout(() => pollCover(f), AREA_POLL_MS);
}
// Lift the cover and play the swoop from the departure pose to the target pose.
function lift(f, ceiling = false) {
  const target = locations.get(f.id);
  logTiming(f, ceiling);
  phase = "flying";
  setCover(false, "choosing");
  const ok = attempt("swoop", () => {
    Camera.stop(); Camera.clearLookAt();
    return Camera.animateTo(pose(target), { duration: flightConfig.durationMs / 1000, easing: flightConfig.easing }) === true;
  });
  if (sel !== f) return;
  if (ok !== true) { failCamera(f); return; }
  f.flightAt = Date.now();
  setCamera("flying", f.id);
  pollTimer = setTimeout(() => pollFlight(f), FLIGHT_POLL_MS);
}
// No end-of-move event exists: Camera.playing is polled. A flight that never reports playing still ends at its nominal duration.
function pollFlight(f) {
  if (sel !== f || phase !== "flying") return;
  pollTimer = null;
  const elapsed = Date.now() - f.flightAt;
  const state = attempt("Camera state", () => ({ active: Camera.active, playing: Camera.playing }));
  if (!state || state.active !== true) { failCamera(f); return; } // the camera was taken away or cannot be read
  if (state.playing === true) f.seenPlaying = true;
  const settled = state.playing !== true && (f.seenPlaying || elapsed >= flightConfig.durationMs);
  if (settled || elapsed >= flightConfig.durationMs + ARRIVAL_GRACE_MS) { arrive(f); return; }
  pollTimer = setTimeout(() => pollFlight(f), FLIGHT_POLL_MS);
}
// The swoop ended: tell the server once for this flight (informational, D8) and the page.
function arrive(f) {
  if (f.arrived) return;
  f.arrived = true; phase = "arrived";
  Events.emitServer("ms-spawn:arrived", { id: f.id });
  setCamera("arrived", f.id);
}
// Teleport failed (signal), or the ceiling passed without its result: lift the cover, the camera stays where it is (decision 3),
// the selection stays (D11), no arrival is reported. The page treats the notice as a preparation failure and a click retries.
function failPrepare(f, text) {
  stopPolling();
  phase = "failed";
  lastCamera = null;
  setCover(false, "choosing");
  sendToPage("notice", { text });
}
// A camera that cannot move must not trap the page. Hand the view back, lift the cover, tell the player, and let the server's
// own fallback timer decide when a confirm is accepted (no arrival report is sent: nothing was seen).
function failCamera(f) {
  stopPolling();
  phase = "arrived";
  restoreCamera(0);
  setCover(false, "choosing");
  sendToPage("notice", { text: FAILED_FLIGHT_NOTICE });
  setCamera("arrived", f.id);
}

// ---- Confirm: cover until the world at the final position is loaded -------------------------------------------------------

function confirmCover(id) {
  phase = "confirming";
  pollTimer = cancelTimer(pollTimer); sel = null;
  setCover(true, "confirm", true);
  ackTimer = cancelTimer(ackTimer);
  // No answer from the server: it dropped the confirm (rate limit) or the message was lost. Lift the cover AND put the page back
  // in "choosing" with a retry notice (SEC-11): the page is otherwise left in "applying" with the list locked.
  ackTimer = setTimeout(guarded("confirm ack", () => {
    ackTimer = null;
    if (phase !== "confirming") return;
    restoreMovement(); // CHG-07: unanswered-confirm guard (not a confirm path), same order as every non-confirm exit
    phase = "arrived"; setCover(false, "confirm");
    lastState = { status: "choosing", selectedId: id, notice: CONFIRM_UNANSWERED_NOTICE };
    serverStatus = "choosing";
    sendToPage("state", lastState);
  }), CONFIRM_ACK_MS);
}
// The server closed after "applying": ms-character has released the player. Wait for the world at the player's own position.
function beginFinish() {
  stopPolling();
  phase = "finishing";
  setCover(true, "confirm");
  const f = sel = { token: ++counter, startedAt: Date.now() };
  pollFinal(f);
}
function pollFinal(f) {
  if (sel !== f || phase !== "finishing") return;
  pollTimer = null;
  // The final position is the player's own (LocalPlayer), never a value from the server payload. No pawn yet = not loaded.
  const loaded = attempt("finalAreaLoaded", () => { const at = LocalPlayer.getPosition(); return Boolean(at) && areaLoaded(at); }) === true;
  if (loaded || Date.now() - f.startedAt >= areaTimeoutMs) { liftFinal(); return; } // the ceiling here is not a failure either
  pollTimer = setTimeout(() => pollFinal(f), AREA_POLL_MS);
}
function liftFinal() {
  pollTimer = cancelTimer(pollTimer); sel = null;
  restoreMovement(); // CHG-07: the final world is loaded (or the ceiling hit); the cover is still opaque
  phase = "leaving";
  setCover(false, "confirm");
  // The page fades out in 150 ms; only after that the camera and the body come back and the page closes (decision 6).
  fadeTimer = setTimeout(() => { fadeTimer = null; teardown(RESTORE_SECONDS); }, FINAL_FADE_MS);
}

// ---- Page events --------------------------------------------------------------------------------------------------

function runSelect(id) {
  lastSelectAt = Date.now();
  Events.emitServer("ms-spawn:select", { id });
  beginSelection(id);
}
function onSelect(payload) {
  const id = payload && typeof payload === "object" ? payload.id : null;
  if (!validId(id) || !locations.has(id)) return;
  if (phase === "confirming" || phase === "finishing" || phase === "leaving") return;
  setCover(true, "choosing"); // the same step as the click, even when the select itself waits for the gap
  const wait = SELECT_GAP_MS - (Date.now() - lastSelectAt);
  if (wait <= 0) { pendingTimer = cancelTimer(pendingTimer); pendingSelect = null; runSelect(id); return; }
  // Too soon after the previous click: the latest click wins once the gap has passed.
  pendingSelect = id;
  if (pendingTimer === null) {
    pendingTimer = setTimeout(guarded("select", () => { pendingTimer = null; const next = pendingSelect; pendingSelect = null; if (next !== null && locations.has(next)) runSelect(next); }), wait);
  }
}
function onConfirm(payload) {
  const id = payload && typeof payload === "object" ? payload.id : null;
  if (!validId(id) || !locations.has(id)) return;
  const cover = phase === "arrived";
  Events.emitServer("ms-spawn:confirm", { id }); // the server decides; this only asks
  if (cover) confirmCover(id);
}

// ---- View ---------------------------------------------------------------------------------------------------------

function flush() {
  if (!pageReady || view === null) return;
  if (pageLocations) Web.emit(view, "open", { locations: pageLocations });
  if (lastState) Web.emit(view, "state", lastState);
  if (lastCamera) Web.emit(view, "camera", lastCamera);
  if (coverState) Web.emit(view, "cover", coverState);
}
function closeView() {
  if (view !== null) attempt("destroyView", () => Web.destroyView(view));
  view = null; pageReady = false;
}
// Tells the server the page is up (its watchdog cancels a selection whose client never does). Once per ms-spawn:open.
function ackOpened() { if (pageReady && view !== null) Events.emitServer("ms-spawn:opened", {}); }
function ensureView() {
  if (view !== null) return;
  view = Web.createView(VIEW_URL, { focus: true });
  Web.on(view, "ready", guarded("ready", () => { pageReady = true; flush(); ackOpened(); }));
  Web.on(view, "select", guarded("select", onSelect));
  Web.on(view, "confirm", guarded("confirm", onConfirm));
}
// Everything back to normal: timers, camera, body, cover, page. Idempotent.
function teardown(duration) {
  pendingTimer = cancelTimer(pendingTimer); pendingSelect = null;
  stopPolling();
  restoreMovement(); // CHG-07 / SEC-17: first, it never throws (every native call is inside attempt)
  if (coverState && coverState.visible) attempt("setCover", () => setCover(false, coverState.moment)); // SEC-17: Web.emit may throw
  restoreCamera(duration);
  restoreBody();
  closeView();
  locations = new Map(); pageLocations = null; lastState = null; lastCamera = null; coverState = null;
  phase = "idle"; serverStatus = null;
}

Events.on("ms-spawn:open", guarded("open", value => {
  const payload = parse(value);
  if (!payload || !Array.isArray(payload.locations)) return;
  const items = payload.locations.filter(item => item && validId(item.id) && typeof item.name === "string" && validPose(item.camera));
  pendingTimer = cancelTimer(pendingTimer); pendingSelect = null;
  stopPolling(); restoreCamera(0);
  // A re-open (new selection, page reused): the body stays hidden, the cover goes (the page resets itself on "open").
  locations = new Map(items.map(item => [item.id, { position: item.camera.position, rotation: item.camera.rotation,
    // An older server sends no departure pose: the swoop then starts at the target pose (nothing is computed here).
    departure: validPose(item.camera.departure) ? item.camera.departure : item.camera }]));
  pageLocations = items.map(item => ({ id: item.id, name: item.name, kind: item.kind === "last" ? "last" : "config", ...(item.kind !== "last" && validIcon(item.icon) ? { icon: item.icon } : {}) }));
  const flightInput = parse(payload.flight);
  flightConfig = {
    durationMs: flightInput && finite(flightInput.durationMs) ? Math.max(300, Math.min(10000, flightInput.durationMs)) : 1500,
    easing: flightInput && EASINGS.includes(flightInput.easing) ? flightInput.easing : "easeInOut",
  };
  timingLog = payload.timingLog === true; // CHG-03: absent (older server) = off
  areaTimeoutMs = finite(payload.areaTimeoutMs) ? Math.max(1000, Math.min(60000, payload.areaTimeoutMs)) : DEFAULT_AREA_TIMEOUT_MS;
  lastState = null; lastCamera = null; coverState = null; lastSelectAt = -Infinity; phase = "idle"; serverStatus = null;
  movementTouched = true; // CHG-07: set before acting; a re-open keeps the hold (settled flags stop a second suspend)
  bodyTries = 0; hideBody(); // once per open: a no-op when body and movement are already set
  ensureView();
  flush();
  ackOpened(); // the page may already be up from a previous selection: its "ready" will not fire again
}));
Events.on("ms-spawn:state", guarded("state", value => {
  const payload = parse(value);
  if (!payload || typeof payload.status !== "string") return;
  if (payload.status === "closed") {
    // Success (the character is in the world) = closed after applying: keep covering until the final world is loaded.
    // Anything else (cancelled selection, session lost, stop, watchdog): lift and give everything back now.
    if (serverStatus === "applying" && (phase === "confirming" || phase === "applying")) beginFinish();
    else if (phase !== "finishing" && phase !== "leaving") teardown(RESTORE_SECONDS);
    return;
  }
  if (payload.status !== "choosing" && payload.status !== "applying") return;
  serverStatus = payload.status;
  const teleport = payload.teleport === "done" || payload.teleport === "failed" ? payload.teleport : null;
  const selectedId = validId(payload.selectedId) ? payload.selectedId : null;
  const notice = typeof payload.notice === "string" && payload.notice ? payload.notice : null;
  // The teleport result belongs to the failure path (notice sent separately with the cover), so it is not forwarded as a state notice.
  // SEC-14: a notice that follows a dropped select makes the client restart for the id the server holds; the server then adds the
  // state of that id's (already finished) move, which the restarted selection adopts below.
  const restart = Boolean(notice && selectedId && sel && sel.id !== selectedId && locations.has(selectedId) && (phase === "covering" || phase === "flying"));
  const failedSignal = teleport === "failed" && ((phase === "covering" && sel && sel.id === selectedId) || restart);
  lastState = { status: payload.status, ...(selectedId ? { selectedId } : {}), ...(notice && !failedSignal ? { notice } : {}) };
  if (payload.status === "applying") {
    // The choice is made: no more arrival reports; ms-character now applies the destination under the confirm cover.
    pollTimer = cancelTimer(pollTimer); ackTimer = cancelTimer(ackTimer); sel = null;
    phase = "confirming";
    setCover(true, "confirm");
    applyTimer = cancelTimer(applyTimer);
    applyTimer = setTimeout(guarded("apply ceiling", () => { applyTimer = null; if (phase === "confirming") liftFinal(); }), APPLY_MAX_MS);
    sendToPage("state", lastState);
    return;
  }
  if (phase === "confirming" && notice) {
    // Server rejection (D11): lift the cover, keep selection, camera and body.
    ackTimer = cancelTimer(ackTimer); applyTimer = cancelTimer(applyTimer);
    phase = "arrived"; setCover(false, "confirm");
  } else if (phase === "covering" && sel && sel.id === selectedId && teleport) {
    // G14: the result of the server's move for the current select (anything for another id is stale and ignored).
    if (teleport === "failed") { failPrepare(sel, notice || FAILED_PREPARE_NOTICE); sendToPage("state", lastState); return; }
    sel.teleport = "done"; sel.teleportDoneAt = Date.now();
    pollTimer = cancelTimer(pollTimer);
    sendToPage("state", lastState);
    pollCover(sel);
    return;
  } else if (restart) {
    // The server is the authority on the selection: if a click was dropped (rate limit), restart for what the server holds.
    beginSelection(selectedId);
    if (sel && sel.id === selectedId && teleport === "failed") { failPrepare(sel, FAILED_PREPARE_NOTICE); sendToPage("state", lastState); return; }
    if (sel && sel.id === selectedId && teleport === "done") { sel.teleport = "done"; sel.teleportDoneAt = Date.now(); } // that move is over: no later signal will come
  }
  sendToPage("state", lastState);
  // The page lifts the cover on any notice: re-assert it while the area is still being prepared.
  if (notice && phase === "covering") setCover(true, "choosing", true);
}));
Events.on("resourceStop", guarded("resourceStop", name => { if (name === "ms-spawn") teardown(0); }));
