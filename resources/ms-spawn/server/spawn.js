"use strict";

const { SpawnError, check, clone, locationId, position } = require("./validation");
const { RESERVED_ID } = require("./config");

const VERSION = "0.3.2";
const CANCEL_REASONS = Object.freeze(["NOT_READY", "NO_OPTIONS", "INTERNAL_ERROR", "STOPPED", "CLIENT_TIMEOUT", "CLIENT_ABORTED"]);
// Per-player ingress token bucket shared by every client event (SEC-01): a burst of 10, refilled at 10 per second.
const BUCKET_SIZE = 10, BUCKET_REFILL_PER_MS = 10 / 1000;
// One notice per code per player every 2 s, whatever the code (SEC-01).
const NOTICE_GAP_MS = 2000;
// An honest client reports arrival at about the nominal flight duration; the tolerance covers the select/flight start skew (SEC-04).
const FLIGHT_TOLERANCE_MS = 250;
// Hold renewal (SEC-08): the native hold carries a 30 min crash-safety TTL; a live selection renews it this often.
const HOLD_RENEW_MS = 10 * 60 * 1000;
const round = value => Math.round(value * 100) / 100;

// Flight-target pose (CameraView shape) derived from a spawn point: `distance` cm behind it (opposite to its yaw),
// `height` cm above it, looking at it. Pure and deterministic. Unreal axes: yaw 0 faces +X, positive pitch looks up.
function cameraPose(point, { distance, height }) {
  const yaw = point.yaw * Math.PI / 180;
  return {
    position: { x: round(point.x - Math.cos(yaw) * distance), y: round(point.y - Math.sin(yaw) * distance), z: round(point.z + height) },
    rotation: { pitch: round(-Math.atan2(height, distance) * 180 / Math.PI), yaw: round(point.yaw), roll: 0 },
  };
}

// CHG-02 (G13): pose the swoop starts from, under the cover: the target pose with an extra `departureDistance` behind and
// `departureHeight` above (same look-at-the-point rule), so the reveal is an aerial move. Derived here, never by the client.
function departurePose(point, camera) {
  return cameraPose(point, { distance: camera.distance + (camera.departureDistance ?? 0), height: camera.height + (camera.departureHeight ?? 0) });
}

// Spawn selection state machine. Dependencies are injected so tests replace them:
// game (native/CEF adapter), core (ms-core's Core export), emit (server events), clock.
// There is no repository: ms-spawn has no database. Lifecycle per player: opening → choosing → applying → closed.
// notices: player-facing text per code (pt-PT, owned by main.js); a missing text means that code is silent.
function createSpawn({ config, game, core, emit = () => {}, logger = console, clock = Date.now, notices = {}, timers = { setTimeout, clearTimeout } }) {
  const selections = new Map();
  let ready = false, closing = false;
  // Native playerIds are reused and ms-core sessions can end mid-operation: re-check on every entry point.
  const valid = s => !closing && selections.get(s.playerId) === s &&
    core.Users.get(s.playerId)?.sessionId === s.sessionId && core.Users.isReady(s.playerId);
  const selectionOf = id => { const s = selections.get(id); check(s && valid(s), "SESSION_EXPIRED"); return s; };
  const event = (name, value) => {
    try { Promise.resolve(emit(name, clone(value))).catch(() => logger.error("[ms-spawn] event handler failed: " + name)); }
    catch { logger.error("[ms-spawn] event handler failed: " + name); }
  };
  function cancel(playerId, sessionId, reason) {
    if (!CANCEL_REASONS.includes(reason)) reason = "INTERNAL_ERROR";
    event("ms:spawnCancelled", { playerId, sessionId, reason });
  }
  // `teleport` ("done" | "failed", CHG-02 G14) is presentation only: it tells the client page that the move of the CURRENT
  // select finished, so its cover can lift. It never carries coordinates and never feeds the confirm gate.
  const send = (s, notice, teleport) => game.state(s.playerId, { status: s.status, ...(s.selectedId ? { selectedId: s.selectedId } : {}),
    ...(teleport ? { teleport } : {}), ...(notice ? { notice } : {}) });
  // The preview hold is released exactly once per hold taken (s.holding), on every exit path.
  function releaseHold(s) {
    if (!s.holding) return;
    s.holding = false;
    try { game.release(s.playerId); } catch { logger.error("[ms-spawn] releasing the preview hold failed"); }
  }
  function close(s, { tell = true, keepHold = false } = {}) {
    if (selections.get(s.playerId) !== s) return;
    const was = s.status;
    s.status = "closed"; selections.delete(s.playerId);
    if (s.queued) { timers.clearTimeout(s.queued); s.queued = null; }
    // A late teleport result of this selection is ignored (valid() is false from here on); drop the native request too.
    if (s.inFlight) { s.inFlight = false; try { game.cancelTeleport(s.playerId); } catch { logger.error("[ms-spawn] cancelling the teleport failed"); } }
    if (!keepHold) releaseHold(s);
    if (tell && was !== "closed") { try { game.state(s.playerId, { status: "closed" }); } catch { logger.error("[ms-spawn] native cleanup failed"); } }
  }
  // Silent drop: the SpawnError code has no notice, so a flood costs the server one counter update per event.
  function admit(s) {
    const now = clock();
    s.tokens = Math.min(BUCKET_SIZE, s.tokens + Math.max(0, now - s.tokensAt) * BUCKET_REFILL_PER_MS); s.tokensAt = now;
    check(s.tokens >= 1, "INGRESS_DROPPED");
    s.tokens -= 1;
  }
  function throttle(s) { check(clock() - s.lastActionAt >= config.actionGapMs, "RATE_LIMITED"); s.lastActionAt = clock(); }

  // The offered list of one player: "last" first (only when ms-character handed one over), then the configuration.
  // `destination` is server-side only; the client receives the id, the name and the derived camera pose.
  function offer(last) {
    const entries = [];
    if (last) entries.push({ id: RESERVED_ID, name: "Última localização", kind: "last", destination: last });
    for (const location of config.locations) {
      entries.push({ id: location.id, name: location.name, kind: "config", destination: { x: location.x, y: location.y, z: location.z, yaw: location.yaw } });
    }
    return entries;
  }

  // ms:spawnSelectionRequested from ms-character. Never throws: failures cancel the request for this player only.
  function request(payload) {
    if (payload === null || typeof payload !== "object" || !Number.isInteger(payload.playerId) || typeof payload.sessionId !== "string" || payload.sessionId === "") {
      logger.error("[ms-spawn] ignored a malformed selection request"); return false;
    }
    const { playerId, sessionId } = payload;
    let s = null;
    try {
      if (!ready || closing) { cancel(playerId, sessionId, "NOT_READY"); return false; }
      // A request for a session that is not the live one is stale: nobody is waiting for an answer.
      if (core.Users.get(playerId)?.sessionId !== sessionId || !core.Users.isReady(playerId)) return false;
      const previous = selections.get(playerId);
      const offered = offer(position(payload.last));
      if (offered.length === 0) { if (previous) close(previous, { tell: false }); cancel(playerId, sessionId, "NO_OPTIONS"); return false; }
      // A replaced selection hands its hold over (never leaves the player unheld between the two).
      if (previous) close(previous, { tell: false, keepHold: true });
      s = { playerId, sessionId, characterId: String(payload.characterId ?? ""), status: "opening", offered: new Map(offered.map(item => [item.id, item])),
        selectedId: null, arrived: false, selectedAt: 0, lastActionAt: 0,
        tokens: BUCKET_SIZE, tokensAt: clock(), noticeAt: new Map(), requestedAt: clock(), opened: false,
        // CHG-01 movement: move = { id, token, status: "pending" | "done" | "failed" } of the latest select.
        move: null, moveToken: 0, inFlight: false, holding: Boolean(previous?.holding), tookOver: Boolean(previous?.tookOver), heldPoint: previous?.heldPoint ?? null,
        // SEC-06: native moves started (capped), start of the last one (minimum interval), queued trailing move timer.
        moves: 0, lastMoveAt: previous?.lastMoveAt ?? -Infinity, queued: null,
        // SEC-06/08: since when the player is unheld (null while held) and when the hold was last (re)issued.
        unheldSince: previous?.unheldSince ?? null, heldAt: previous?.heldAt ?? clock() };
      selections.set(playerId, s);
      // SEC-09: the carried-over selection took the player over but the replaced one left no hold (it was mid-teleport or
      // its re-hold failed): hold again, or fall back to the default spawn. Never continue with an unheld player.
      if (s.tookOver && !s.holding) {
        let held = false;
        try { held = game.hold(playerId, s.heldPoint) === true; } catch { held = false; }
        if (!held) { logger.error("[ms-spawn] re-holding a carried-over selection failed, falling back to the default spawn"); close(s); cancel(playerId, sessionId, "INTERNAL_ERROR"); return false; } // SEC-13: tell the page (default), so a page of the replaced selection closes and restores the body
        s.holding = true; s.unheldSince = null; s.heldAt = clock();
      }
      game.open(playerId, {
        locations: offered.map(({ id, name, kind, destination }) => ({ id, name, kind, camera: { ...cameraPose(destination, config.camera), departure: departurePose(destination, config.camera) } })),
        flight: { durationMs: config.camera.durationMs, easing: config.camera.easing },
        areaTimeoutMs: config.areaTimeoutMs,
        timingLog: config.timingLog === true, // CHG-03: only tells the client script to console.log its timing line
      });
      if (!valid(s)) { close(s, { tell: false }); return false; }
      s.status = "choosing"; send(s);
      return true;
    } catch (error) {
      logger.error("[ms-spawn] opening the selection failed: " + (error?.code || error?.name || "UNKNOWN"));
      if (s) close(s);
      cancel(playerId, sessionId, "INTERNAL_ERROR");
      return false;
    }
  }

  // Client events. Only `payload.id` is ever read: coordinates sent by a client are ignored.
  function select(playerId, payload) {
    const s = selectionOf(playerId); admit(s);
    check(s.status === "choosing", "INVALID_STATE"); throttle(s);
    const id = locationId(payload);
    check(s.offered.has(id), "INVALID_LOCATION");
    // A1: selecting the id the player already stands at (or is being taken to) restarts the camera flight (arrival and
    // gate timer) but does not teleport again. A failed move is retried.
    const same = s.move !== null && s.move.id === id && s.move.status !== "failed";
    // SEC-06: a bounded number of native moves per selection; the selection stays where it is (notice only).
    if (!same) check(s.moves < config.maxMoves, "MOVE_LIMIT");
    s.selectedId = id; s.arrived = false; s.selectedAt = clock();
    // Re-selecting the id whose teleport already finished: no new move will signal it, so say it now (G14).
    send(s, undefined, same && s.move.status === "done" ? "done" : undefined);
    if (!same) startMove(s, id);
  }
  // CHG-01: take the player to the selected server-held point and hold them there, so the world streams around the
  // camera. Never parallel: the new teleport supersedes a pending one (the adapter resolves the old one "replaced"), and
  // every continuation re-checks the selection and its own token, so only the latest select can update state or holds.
  // SEC-06: at most one native move per `moveGapMs`; a select inside the gap supersedes the queued one (latest wins) and
  // runs on a trailing timer, so a client alternating ids costs one teleport per gap, never one per select.
  function startMove(s, id) {
    const token = ++s.moveToken;
    s.move = { id, token, status: "pending" };
    s.moves += 1;
    if (s.queued) { timers.clearTimeout(s.queued); s.queued = null; }
    const point = s.offered.get(id).destination;
    const launch = () => { s.lastMoveAt = clock(); move(s, token, point, id).catch(() => logger.error("[ms-spawn] move failed unexpectedly")); };
    const wait = s.lastMoveAt + config.moveGapMs - clock();
    if (wait <= 0) { launch(); return; }
    s.queued = timers.setTimeout(() => { s.queued = null; if (valid(s) && s.move !== null && s.move.token === token) launch(); }, wait);
    if (typeof s.queued?.unref === "function") s.queued.unref();
  }
  // CHG-03: one English line per teleport result that really arrived (a native status 0..5 or the adapter timeout). No coordinates,
  // no account data: the player's native id and the configured location id only. Superseded/dropped requests resolve without status and are not logged.
  function logTiming(s, id, ms, outcome) {
    if (config.timingLog !== true || !outcome) return;
    const status = outcome.result === "timeout" ? "timeout" : Number.isInteger(outcome.status) ? outcome.status : null;
    if (status === null) return;
    if (typeof logger.log !== "function") return;
    try { logger.log(`[ms-spawn] timing player=${s.playerId} select=${id} teleportMs=${Math.max(0, Math.round(ms))} status=${status} snap=${config.previewSnapToGround === true}`); } catch { /* logging never affects the move */ }
  }
  async function move(s, token, point, id) {
    const current = () => valid(s) && s.move !== null && s.move.token === token;
    let outcome;
    try {
      if (!s.tookOver) {
        // Fail safe: if the takeover is refused nothing was released, so the lobby hold keeps the player.
        if (game.takeover(s.playerId) !== true) throw new SpawnError("TAKEOVER_FAILED");
        s.tookOver = true; s.holding = true; s.heldAt = clock();
      }
      releaseHold(s); // a hold would clamp the move; the game itself keeps a snapping player on the ground meanwhile
      if (s.unheldSince === null) s.unheldSince = clock(); // bounded by the watchdog (tick): see maxUnheldMs
      if (s.inFlight) game.cancelTeleport(s.playerId);
      s.inFlight = true;
      const startedAt = clock();
      outcome = await game.teleport(s.playerId, point, { snapToGround: config.previewSnapToGround === true });
      logTiming(s, id, clock() - startedAt, outcome);
    } catch (error) {
      outcome = { result: "failed", status: null, error: true };
    }
    if (!current()) return; // superseded, or the selection/session is gone: whoever replaced it owns the hold now
    s.inFlight = false;
    if (outcome && outcome.result === "ok") {
      let held = false;
      try { held = game.hold(s.playerId, point) === true; } catch { held = false; }
      if (!current()) return;
      s.holding = held;
      s.move.status = "done";
      if (!held) {
        // SEC-09: the hold is required once the player was taken over: without it the selection ends (default spawn, no kick).
        logger.error("[ms-spawn] re-holding the player failed, falling back to the default spawn");
        abort(s.playerId, "INTERNAL_ERROR");
        return;
      }
      s.heldPoint = point; s.unheldSince = null; s.heldAt = clock();
      send(s, undefined, "done"); // G14: only the latest select's result is signalled (current() above)
      return;
    }
    // Failure (statuses 2..5, timeout, adapter error, or a foreign "replaced"): keep the selection, hold the player again
    // at the last held point (or where they are), tell them, and let the arrival report or the fallback timer decide.
    s.move.status = "failed";
    logger.error("[ms-spawn] teleport did not complete: " + (outcome && outcome.result ? outcome.result : "unknown") + (outcome && outcome.status != null ? " " + outcome.status : ""));
    if (s.tookOver && !s.holding) {
      try { s.holding = game.hold(s.playerId, s.heldPoint) === true; } catch { s.holding = false; }
      if (!current()) return;
      if (!s.holding) { logger.error("[ms-spawn] re-holding the player failed, falling back to the default spawn"); abort(s.playerId, "INTERNAL_ERROR"); return; }
      s.unheldSince = null; s.heldAt = clock();
    }
    // G14: the failure is always signalled (the client cover must lift); bounded by moveGapMs and maxMoves, so it needs no extra limit.
    s.noticeAt.set("TELEPORT_FAILED", clock());
    send(s, notices.TELEPORT_FAILED || undefined, "failed");
  }
  // Informational (UI gate): reporting an arrival can only make confirm available earlier, it never chooses the destination.
  function arrived(playerId, payload) {
    const s = selectionOf(playerId); admit(s);
    if (s.status !== "choosing" || s.selectedId === null) return false;
    if (locationId(payload) !== s.selectedId) return false;
    // SEC-04: a report earlier than the flight can have lasted does not open the gate (the fallback timer still applies).
    if (clock() - s.selectedAt < minFlightMs()) return false;
    s.arrived = true;
    return true;
  }
  const minFlightMs = () => Math.max(0, Math.min(config.camera.durationMs, config.areaTimeoutMs) - FLIGHT_TOLERANCE_MS);
  // The client page is up (sent on every ms-spawn:open once the page is ready): proof that the client side is alive.
  function opened(playerId) { const s = selectionOf(playerId); admit(s); s.opened = true; return true; }
  // SEC-12: the client tore its UI down on its own (emergency teardown) and gives the player back: a selection still waiting
  // for the player ends and ms-character falls back to the default spawn. Reads no payload, behind the ingress bucket.
  // Ignored in any other state (applying/closed): there ms-character already owns the outcome.
  function abandon(playerId) {
    const s = selectionOf(playerId); admit(s);
    if (s.status !== "opening" && s.status !== "choosing") return false;
    logger.error("[ms-spawn] the client abandoned the selection, falling back to the default spawn");
    return abort(playerId, "CLIENT_ABORTED");
  }
  function confirm(playerId, payload) {
    const s = selectionOf(playerId); admit(s);
    check(s.status === "choosing", "INVALID_STATE"); throttle(s);
    const id = locationId(payload);
    check(s.offered.has(id), "INVALID_LOCATION");
    // The id must be the one the player selected (and flew to).
    check(s.selectedId === id, "LOCATION_REJECTED");
    // D8: the camera must have arrived, or the fallback timer must have elapsed; and (CHG-01) the teleport of this select
    // must not be pending (done or failed both pass). The client's own "area loaded" is never an input here.
    check(s.move !== null && s.move.status !== "pending", "NOT_ARRIVED");
    check(s.arrived || clock() - s.selectedAt >= config.areaTimeoutMs, "NOT_ARRIVED");
    const { destination } = s.offered.get(id);
    s.status = "applying";
    // ms-character applies the destination itself and expects an unheld player (as after its own lobby release).
    releaseHold(s);
    send(s);
    event("ms:spawnSelected", { playerId, sessionId: s.sessionId, destination: { x: destination.x, y: destination.y, z: destination.z, yaw: destination.yaw } });
  }

  // An unexpected failure for one player: ms-character is still waiting for an answer, so fall back to its default.
  function abort(playerId, reason = "INTERNAL_ERROR") {
    const s = selections.get(playerId);
    if (!s) return false;
    const waiting = s.status === "opening" || s.status === "choosing";
    close(s);
    if (waiting) cancel(s.playerId, s.sessionId, reason);
    return waiting;
  }
  // The character is in the world (or the session is gone): nothing left to choose. Session end/disconnect emit nothing.
  function characterReady(payload) {
    const s = payload && selections.get(payload.playerId);
    if (s && s.sessionId === payload.sessionId) close(s);
  }
  function sessionEnded(sessionId) {
    for (const s of [...selections.values()]) if (s.sessionId === sessionId) close(s, { tell: false });
  }
  function disconnect(playerId) { const s = selections.get(playerId); if (s) close(s, { tell: false }); }
  // Watchdog (SEC-03), polled by main.js: a selection whose client never confirmed the page opened is cancelled.
  // Idle players are not affected: the clock stops at the first acknowledgement.
  function tick() {
    const now = clock();
    for (const s of [...selections.values()]) {
      if (!s.opened && (s.status === "opening" || s.status === "choosing") && now - s.requestedAt >= config.openAckTimeoutMs) {
        logger.error("[ms-spawn] the client page never opened, falling back to the default spawn");
        abort(s.playerId, "CLIENT_TIMEOUT");
        continue;
      }
      if (s.status !== "choosing" && s.status !== "opening") continue;
      // SEC-06: a selection may not stay unheld (moves in flight, failed or superseded) longer than the bound.
      if (s.tookOver && !s.holding && s.unheldSince !== null && now - s.unheldSince >= config.maxUnheldMs) {
        logger.error("[ms-spawn] the player stayed unheld too long, falling back to the default spawn");
        abort(s.playerId, "INTERNAL_ERROR");
        continue;
      }
      // SEC-08: the 30 min hold TTL is only a crash safety net. A live selection renews it (release then hold: the result is
      // the same whether the game replaces or stacks a same-owner hold). A failed renewal ends the selection.
      if (s.holding && !s.inFlight && now - s.heldAt >= HOLD_RENEW_MS) {
        game.release(s.playerId); s.holding = false;
        let held = false;
        try { held = game.hold(s.playerId, s.heldPoint) === true; } catch { held = false; }
        if (!held) { logger.error("[ms-spawn] renewing the preview hold failed, falling back to the default spawn"); abort(s.playerId, "INTERNAL_ERROR"); continue; }
        s.holding = true; s.heldAt = now;
      }
    }
  }
  function start() { ready = true; closing = false; }
  // Resource stop/reload: whoever ms-character still waits for falls back to the default destination.
  function stop() {
    ready = false; closing = true;
    for (const s of [...selections.values()]) abort(s.playerId, "STOPPED");
  }

  const api = Object.freeze({
    version: VERSION,
    isReady: () => ready && !closing,
    // True while a selection for exactly this session is waiting for the player (lets ms-character detect a reload that lost it).
    holds: (playerId, sessionId) => { const s = selections.get(playerId); return Boolean(s && s.sessionId === sessionId && (s.status === "opening" || s.status === "choosing")); },
    locations: () => Object.freeze(config.locations.map(({ id, name }) => Object.freeze({ id, name }))),
  });
  // A rejected request keeps the selection (D11): the notice travels with the current status and selected id.
  // At most one notice per code per player every 2 s.
  function notify(playerId, text, code = "") {
    const s = selections.get(playerId); if (!s) return false;
    const now = clock();
    if (now - (s.noticeAt.get(code) ?? -Infinity) < NOTICE_GAP_MS) return false;
    // SEC-14: when the server-held selection's move already finished (or failed), say so, so a client that restarts for this id
    // does not wait for a signal that will never come again. Same presentation-only field as after a select.
    const held = s.selectedId !== null && s.move !== null && s.move.id === s.selectedId ? s.move.status : null;
    s.noticeAt.set(code, now); send(s, text, held === "done" || held === "failed" ? held : undefined);
    return true;
  }
  return { api, start, stop, tick, notify, request, select, arrived, opened, abandon, confirm, abort, characterReady, sessionEnded, disconnect,
    guard(id) { const s = selections.get(id); return () => Boolean(s && selections.get(id) === s); } };
}

module.exports = { createSpawn, cameraPose, departurePose, CANCEL_REASONS, VERSION, SpawnError };
