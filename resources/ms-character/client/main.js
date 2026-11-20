"use strict";

// Client script for ms-character. See docs/architecture-plan.md §4.4 (page <-> client contract) and §5.4 (lobby preview).
// One Creator session at a time, shared by the lobby preview and the creator. Creator.cancel() does NOT revert
// (findings §2), so every release goes through release(), which restores originalLook first.

const PREVIEW_DEBOUNCE_MS = 80;
const SCHEMA_POLL_MS = 50;
const COMMIT_REPLY_TIMEOUT_MS = 150;
const BODY_SCHEMA_FALLBACK_MS = 250;
const SCHEMA_TIMEOUT_MS = 2000;
const REFERENCE_WIDTH = 1920;

// Tuned by the user at 1920x1080 (findings §4.2). `shift` is proportional to the screen width.
// The face preset has no fov on purpose: the value was left to the game.
const FRAMES = Object.freeze({
  body: Object.freeze({ dist: 720, height: -25, pitch: 2, shift: 80, fov: 28 }),
  face: Object.freeze({ dist: 130, height: 65, pitch: 0, shift: 15 }),
});

let view = null, pageReady = false, lastState = null;
// session is non-null only while this resource owns the Creator session.
let session = null, sessionCounter = 0;
let cameraTouched = false, frozen = false;
let creatorOpen = false;      // the page is in the creator (as opposed to the lobby preview)
let pronoun = null;           // chosen pronoun, applied to the exported look on create
let pendingPatch = null, patchTimer = null;
let schemaTimer = null, schemaToken = 0, bodyAwait = false;
let expectPreset = null;      // preset a body switch asked for: the schema is only trusted once the state shows it

function attempt(label, fn) {
  try { return fn(); } catch (error) {
    if (typeof console !== "undefined" && console.log) console.log("[ms-character] " + label + " failed: " + (error && error.message ? error.message : error));
    return undefined;
  }
}
function cancelTimer(timer) { if (timer !== null && timer !== undefined) clearTimeout(timer); return null; }
function sendToPage(name, payload) { if (pageReady && view !== null) Web.emit(view, name, payload); }

function setControls(enabled) {
  if (enabled) LocalPlayer.restorePlayerInput(); else LocalPlayer.stopPlayerInput();
  Game.setPauseMenuEnabled(enabled);
  Game.setActionScreenEnabled(enabled);
  Game.setToolWheelEnabled(enabled);
}

// ---- Camera (STORY-04.01) ----------------------------------------------------------------------------------------

function setFrame(name) {
  if (session === null) return;
  const base = Object.prototype.hasOwnProperty.call(FRAMES, name) ? FRAMES[name] : null;
  if (base === null) return;
  const size = Web.getScreenSize();
  const width = size && Number.isFinite(size.width) && size.width > 0 ? size.width : REFERENCE_WIDTH;
  cameraTouched = true; // set first: a throw inside setCamera must still be undone by restoreCamera
  // A turn made under one frame leaves the camera off-centre under another (face -> body), so every frame
  // change starts from the initial angle.
  unrotate();
  CreatorPreview.setCamera({ ...base, shift: base.shift * (width / REFERENCE_WIDTH) });
}

// Turns the previewed character. The page is untrusted input for the game: finite numbers only, clamped per call.
const ROTATE_MAX_DELTA = 45;
function onRotate(payload) {
  if (session === null || !payload || typeof payload !== "object") return;
  const delta = Number(payload.delta);
  if (!Number.isFinite(delta) || delta === 0) return;
  const applied = Math.max(-ROTATE_MAX_DELTA, Math.min(ROTATE_MAX_DELTA, delta));
  if (attempt("rotate", () => { CreatorPreview.rotate(applied); return true; })) turned += applied;
}
// rotate() is relative and there is no getter, so the total is tracked to be undone on release.
let turned = 0;
function unrotate() {
  const back = turned; turned = 0;
  if (back !== 0) attempt("unrotate", () => CreatorPreview.rotate(-back));
}

// ---- Creator session (STORY-04.02 / 04.03) -----------------------------------------------------------------------

// getState() right after applyPatch() can still return the old selection: the game applies the patch a few ms
// later (creatorChanged). A commit is therefore answered with the state read after that event.
let commitPending = 0, commitTimer = null;
function replyState() {
  const state = attempt("getState", () => Creator.getState());
  if (state) sendToPage("creator:state", state);
}
function flushCommit() { commitTimer = cancelTimer(commitTimer); commitPending = 0; replyState(); }
function expectCommitReply(result) {
  if (!result) { replyState(); return; } // nothing was applied, so no event will come
  commitPending++;
  commitTimer = cancelTimer(commitTimer);
  commitTimer = setTimeout(flushCommit, COMMIT_REPLY_TIMEOUT_MS);
}

function clearTimers() {
  commitTimer = cancelTimer(commitTimer); commitPending = 0; expectPreset = null;
  voiceTimer = cancelTimer(voiceTimer); voicePlayTimer = cancelTimer(voicePlayTimer); pendingVoice = null;
  patchTimer = cancelTimer(patchTimer); pendingPatch = null;
  schemaTimer = cancelTimer(schemaTimer); schemaToken++; bodyAwait = false;
}

// Idempotent. Only touches what this resource acquired.
function release() {
  clearTimers();
  creatorOpen = false; pronoun = null; chosenVoice = null;
  if (session !== null) unrotate(); // back to the initial angle, while the preview is still frozen
  if (session !== null) {
    const { originalLook } = session;
    session = null;
    if (originalLook) attempt("importLook(originalLook)", () => Creator.importLook(originalLook));
    attempt("Creator.cancel", () => Creator.cancel());
  }
  if (frozen) {
    frozen = false;
    attempt("unfreeze", () => CreatorPreview.freeze(false));
  }
  if (cameraTouched) {
    cameraTouched = false;
    attempt("restoreCamera", () => CreatorPreview.restoreCamera());
  }
}

// Returns true when this resource owns a session (opens one if needed).
function acquire() {
  if (session !== null) return true;
  const originalLook = Creator.exportLook();
  if (!originalLook) return false;
  if (Creator.begin({ preserveCurrent: true }) !== true) return false;
  session = { id: ++sessionCounter, originalLook };
  // A still pose: idle animations move the character out of the camera frame.
  frozen = true;
  attempt("freeze", () => CreatorPreview.freeze(true));
  return true;
}

function openLobbySession() {
  if (session !== null) return;
  turned = 0; // a fresh session starts at the initial angle
  if (!attempt("open lobby session", acquire)) return;
  attempt("body frame", () => setFrame("body"));
}

// The game swaps the schema IDs when the body changes, and getSchema() can lag behind getState(): a schema whose
// options do not contain the state's selections belongs to the other body, and patches built from it are ignored.
function consistent(schema, state) {
  const selections = state && typeof state.selections === "object" && state.selections ? state.selections : {};
  for (const id of Object.keys(selections)) {
    const category = schema.categories[id];
    if (category && Array.isArray(category.options) && category.options.indexOf(selections[id]) === -1) return false;
  }
  return true;
}

function buildSchema(force) {
  const schema = Creator.getSchema();
  if (!schema || !schema.categories) return null;
  const state = Creator.getState();
  if (!force && (!consistent(schema, state) || (expectPreset !== null && !(state && state.selections && state.selections.preset === expectPreset)))) return null;
  if (expectPreset !== null && state && state.selections && state.selections.preset !== expectPreset) {
    state.selections = { ...state.selections, preset: expectPreset }; // forced after a timeout: the game accepted the patch (result 1)
  }
  return {
    capabilities: Creator.getCapabilities(),
    categories: Object.keys(schema.categories).map(id => ({ id, options: schema.categories[id].options })),
    state,
  };
}

function deliverSchema(force) {
  const payload = attempt("buildSchema", () => buildSchema(force));
  if (!payload) return false;
  expectPreset = null;
  sendToPage("creator:schema", payload);
  return true;
}

function failCreator(code) {
  schemaTimer = cancelTimer(schemaTimer); schemaToken++; bodyAwait = false;
  creatorOpen = false;
  sendToPage("creator:error", { code });
}

// Waits until the schema stops being null (first creatorChanged or poll), then sends it once.
function sendSchemaWhenReady(forceOnTimeout) {
  schemaTimer = cancelTimer(schemaTimer);
  const token = ++schemaToken, sessionId = session && session.id;
  const startedAt = Date.now();
  const poll = () => {
    if (token !== schemaToken || session === null || session.id !== sessionId) return;
    if (deliverSchema()) { schemaTimer = null; return; }
    if (Date.now() - startedAt >= SCHEMA_TIMEOUT_MS) {
      schemaTimer = null;
      if (!(forceOnTimeout && deliverSchema(true))) failCreator("SCHEMA_TIMEOUT");
      return;
    }
    schemaTimer = setTimeout(poll, SCHEMA_POLL_MS);
  };
  poll();
}

function beginCreator() {
  unrotate(); // the creator always opens at the initial angle, even if the lobby preview was turned
  if (session !== null) {
    // Shared session from the lobby: the previewed card look must not leak into the creator.
    if (!attempt("importLook(originalLook)", () => Creator.importLook(session.originalLook))) { failCreator("CREATOR_BEGIN_FAILED"); return; }
    if (!attempt("Creator.isActive", () => Creator.isActive()) && attempt("begin", () => Creator.begin({ preserveCurrent: true })) !== true) {
      release(); failCreator("CREATOR_BEGIN_FAILED"); return;
    }
  } else if (!attempt("open creator session", acquire)) {
    release(); failCreator("CREATOR_BEGIN_FAILED"); return;
  }
  creatorOpen = true; pronoun = null; chosenVoice = null;
  sendSchemaWhenReady();
}

function cancelCreator() {
  // Back to the lobby: keep the shared session (still frozen, camera never released) and only restore the account
  // look, the initial angle and the body frame. Releasing and reopening goes through restoreCamera and the default
  // camera first, which shows as a fast camera swing.
  if (session !== null && pageReady && lastState && lastState.status === "lobby") {
    clearTimers();
    creatorOpen = false; pronoun = null; chosenVoice = null;
    attempt("importLook(originalLook)", () => Creator.importLook(session.originalLook));
    unrotate();
    attempt("body frame", () => setFrame("body"));
    return;
  }
  // importLook(originalLook) + Creator.cancel() + restoreCamera() (plan §4.4), then the lobby preview starts a new session.
  release();
  if (pageReady && lastState && lastState.status === "lobby") openLobbySession();
}

const isId = value => typeof value === "string" && value.length <= 128;

function applyPatchNow(category, id) {
  if (session === null || !creatorOpen) return;
  return attempt("applyPatch", () => Creator.applyPatch({ [category]: id }));
}

function onPatch(payload) {
  if (session === null || !creatorOpen || !payload || !isId(payload.category) || payload.category === "" || !isId(payload.id)) return;
  // A preset swaps the whole look and the schema: only a committed choice applies (no hover preview).
  if (payload.category === "preset") { if (payload.commit === true) onBody({ preset: payload.id }); return; }
  if (payload.commit === true) {
    patchTimer = cancelTimer(patchTimer);
    // A committed choice supersedes any queued preview, including one for another category.
    pendingPatch = null;
    expectCommitReply(applyPatchNow(payload.category, payload.id));
    return;
  }
  pendingPatch = { category: payload.category, id: payload.id, sessionId: session.id };
  patchTimer = cancelTimer(patchTimer);
  patchTimer = setTimeout(() => {
    patchTimer = null;
    const patch = pendingPatch; pendingPatch = null;
    if (!patch || session === null || session.id !== patch.sessionId) return;
    applyPatchNow(patch.category, patch.id);
  }, PREVIEW_DEBOUNCE_MS);
}

function onBody(payload) {
  if (session === null || !creatorOpen || !payload || !isId(payload.preset) || payload.preset === "") return;
  // A queued preview was made against the old body's IDs.
  patchTimer = cancelTimer(patchTimer); pendingPatch = null;
  expectPreset = payload.preset;
  applyPatchNow("preset", payload.preset);
  // The game applies the patch a few ms later: wait for its creatorChanged (or a short fallback) before reading the
  // new schema, otherwise the old body's schema and state still agree with each other and would be sent again.
  bodyAwait = true;
  schemaTimer = cancelTimer(schemaTimer);
  const token = ++schemaToken, sessionId = session.id;
  schemaTimer = setTimeout(() => {
    schemaTimer = null;
    if (token !== schemaToken || !bodyAwait || session === null || session.id !== sessionId) return;
    bodyAwait = false; sendSchemaWhenReady(true);
  }, BODY_SCHEMA_FALLBACK_MS);
}

function onPronoun(payload) {
  if (!payload || (payload.pronoun !== "witch" && payload.pronoun !== "wizard")) return;
  pronoun = payload.pronoun;
}

function onCreate(payload) {
  if (!payload || typeof payload !== "object") return;
  const request = { firstName: payload.firstName, lastName: payload.lastName, house: payload.house };
  if (session === null || !creatorOpen) { Events.emitServer("ms-character:create", request); return; }
  const exported = attempt("exportLook", () => Creator.exportLook());
  if (!exported) { sendToPage("creator:error", { code: "LOOK_EXPORT_FAILED" }); return; }
  const look = { ...exported, ...(pronoun ? { pronoun } : {}), ...(chosenVoice ? { voice: chosenVoice } : {}) };
  Events.emitServer("ms-character:create", { ...request, look });
  release();
}

// Voice (findings §8): setVoice takes integers; tone is clamped by the game to 0..1, pitch is not clamped, so the
// limit is ours (VOICE_PITCH_MAX, the same one the server enforces). Like a patch, it applies a few ms later.
const VOICE_PITCH_MAX = 10;
const VOICE_PLAY_DELAY_MS = 120;
let voiceTimer = null, voicePlayTimer = null, pendingVoice = null, chosenVoice = null; // chosenVoice goes into the created look (exportLook can lag a few ms)
const isVoice = voice => voice && typeof voice === "object" && Number.isInteger(voice.tone) && voice.tone >= 0 && voice.tone <= 1
  && Number.isInteger(voice.pitch) && Math.abs(voice.pitch) <= VOICE_PITCH_MAX;
function onVoice(payload) {
  if (session === null || !creatorOpen || !isVoice(payload)) return;
  chosenVoice = { tone: payload.tone, pitch: payload.pitch };
  pendingVoice = { tone: payload.tone, pitch: payload.pitch, sessionId: session.id };
  voiceTimer = cancelTimer(voiceTimer);
  voiceTimer = setTimeout(() => {
    voiceTimer = null;
    const voice = pendingVoice; pendingVoice = null;
    if (!voice || session === null || session.id !== voice.sessionId) return;
    attempt("setVoice", () => Creator.setVoice({ tone: voice.tone, pitch: voice.pitch }));
  }, PREVIEW_DEBOUNCE_MS);
}
function onVoicePreview() {
  if (session === null || !creatorOpen) return;
  // A queued change must be applied before the sample plays.
  if (voiceTimer !== null) {
    voiceTimer = cancelTimer(voiceTimer);
    const voice = pendingVoice; pendingVoice = null;
    if (voice && session.id === voice.sessionId) attempt("setVoice", () => Creator.setVoice({ tone: voice.tone, pitch: voice.pitch }));
  }
  // The game applies setVoice a few ms later (like a patch): play after that, or the previous voice is heard.
  const sessionId = session.id;
  voicePlayTimer = cancelTimer(voicePlayTimer);
  voicePlayTimer = setTimeout(() => {
    voicePlayTimer = null;
    if (session !== null && session.id === sessionId) attempt("previewVoice", () => Creator.previewVoice());
  }, VOICE_PLAY_DELAY_MS);
}

function onSelect(payload) {
  release(); // restore the look, cancel and restore the camera before the server applies the character
  Events.emitServer("ms-character:select", payload);
}

function onLobbyPreview(payload) {
  if (session === null || creatorOpen) return;
  const characterId = payload && typeof payload === "object" ? payload.characterId : null;
  let look = null;
  if (characterId !== null && characterId !== undefined && lastState && Array.isArray(lastState.characters)) {
    const character = lastState.characters.find(item => item && String(item.characterId) === String(characterId));
    if (character && character.look) look = character.look;
  }
  if (look && attempt("importLook(character)", () => Creator.importLook(look))) return;
  attempt("importLook(originalLook)", () => Creator.importLook(session.originalLook));
}

// ---- View --------------------------------------------------------------------------------------------------------

// ---- World gate: the lobby spawn is only shown once the world around it has loaded ------------------------------------
// The server confirms the ground with the game's own wait (Player.teleport snapToGround holds the player until the floor
// loads; playerTeleportComplete reports groundSnapped) and sends groundSnapped=true when the lobby opens: then the world
// is loaded. While the state is still "loading" nothing is checked here. Only when the server could not confirm it
// (groundSnapped false) does this script poll World.lineTrace under the player as a fallback (docs/arcane-mp/guides/world/
// line-traces.md: a null result can mean "not loaded yet"), for at most WORLD_TIMEOUT_MS. UI only: it authorises nothing,
// and a failing check or the ceiling shows the page anyway (never block a player forever).
const WORLD_POLL_MS = 250, WORLD_TIMEOUT_MS = 5000;
const GROUND_OBJECT_TYPES = ["worldStatic", "shallowWater", "deepWater"];
let worldLoaded = false, worldTimer = null, worldStartedAt = 0;
function groundLoaded() {
  const at = LocalPlayer.getPosition();
  if (!at) return false;
  const hit = World.lineTrace({ x: at.x, y: at.y, z: at.z + 100 }, { x: at.x, y: at.y, z: at.z - 10000 }, { objectTypes: GROUND_OBJECT_TYPES });
  return Boolean(hit) && hit.startPenetrating !== true;
}
function setWorldLoaded() {
  worldTimer = cancelTimer(worldTimer); worldLoaded = true;
  flush();
  if (pageReady && lastState && lastState.status === "lobby") openLobbySession();
}
function pollWorld() {
  worldTimer = null;
  if (worldLoaded || lastState === null) return;
  let loaded;
  try { loaded = groundLoaded(); }
  catch (error) { console.log("[ms-character] world check failed: " + (error && error.message ? error.message : error)); setWorldLoaded(); return; }
  if (loaded || Date.now() - worldStartedAt >= WORLD_TIMEOUT_MS) { setWorldLoaded(); return; }
  worldTimer = setTimeout(pollWorld, WORLD_POLL_MS);
}
function waitForWorld() {
  if (worldLoaded || worldTimer !== null) return;
  worldStartedAt = Date.now();
  worldTimer = setTimeout(pollWorld, WORLD_POLL_MS);
}
function resetWorldGate() { worldTimer = cancelTimer(worldTimer); worldLoaded = false; }

function flush() { if (pageReady && view !== null && lastState) Web.emit(view, "state", { ...lastState, worldLoaded }); }
function closeView() {
  if (view !== null) Web.destroyView(view);
  view = null; pageReady = false;
}
// ms-spawn (optional) owns the screen between choosingSpawn and playing: the page stays closed and the controls stay
// disabled (ms-spawn touches neither), whether the choice ends in a selection or a cancellation.
let handedOver = false;
function show(state) {
  lastState = state;
  if (state.status === "playing" || state.status === "closed") { handedOver = false; resetWorldGate(); }
  if (state.status === "loading") resetWorldGate(); // a new lobby: its spawn has to load again
  if (state.status === "playing") { release(); closeView(); setControls(true); return; }
  if (state.status === "choosingSpawn") { handedOver = true; setControls(false); release(); closeView(); return; }
  if (handedOver && state.status === "applying") return;
  if (state.status === "lobby") handedOver = false;
  setControls(false);
  if (view === null) {
    view = Web.createView("fw://resources/ms-character/client/ui/index.html", { focus: true });
    Web.on(view, "ready", () => { pageReady = true; flush(); if (worldLoaded && lastState && lastState.status === "lobby") openLobbySession(); });
    Web.on(view, "create", onCreate);
    Web.on(view, "select", onSelect);
    Web.on(view, "delete", payload => Events.emitServer("ms-character:delete", payload));
    Web.on(view, "camera:frame", payload => { if (payload && typeof payload === "object") attempt("camera:frame", () => setFrame(payload.framing)); });
    Web.on(view, "lobby:preview", onLobbyPreview);
    Web.on(view, "model:rotate", onRotate);
    Web.on(view, "creator:begin", beginCreator);
    Web.on(view, "creator:cancel", cancelCreator);
    Web.on(view, "creator:patch", onPatch);
    Web.on(view, "creator:body", onBody);
    Web.on(view, "creator:pronoun", onPronoun);
    Web.on(view, "creator:voice", onVoice);
    Web.on(view, "creator:voice:preview", onVoicePreview);
  }
  if (state.status !== "loading") {
    if (state.groundSnapped === true) { worldTimer = cancelTimer(worldTimer); worldLoaded = true; }
    else waitForWorld();
  }
  flush();
  // Back in the lobby after a failed select/create: the session was released, so open it again.
  if (pageReady && worldLoaded && state.status === "lobby") openLobbySession();
}

Events.on("creatorChanged", state => {
  if (session === null || !creatorOpen) return;
  if (bodyAwait && state && state.change && state.change.category === "preset") {
    bodyAwait = false; schemaTimer = cancelTimer(schemaTimer);
    sendSchemaWhenReady(true);
    return;
  }
  if (schemaTimer !== null) return; // sendSchemaWhenReady is still polling; it sends the state with the schema
  sendToPage("creator:state", state);
  if (commitPending > 0 && state && state.change) {
    commitPending--;
    if (commitPending === 0) commitTimer = cancelTimer(commitTimer);
    replyState();
  }
});
Events.on("ms-character:state", state => {
  if (!state || typeof state !== "object" || typeof state.status !== "string") return;
  show(state);
});
Events.on("ms-character:notice", value => {
  if (!value || typeof value.text !== "string") return;
  Game.notify(value.text);
  if (pageReady && view !== null) Web.emit(view, "notice", { text: value.text });
});
Events.on("resourceStart", name => { if (name === "ms-character") Events.emitServer("ms-character:sync"); });
Events.on("resourceStop", name => {
  if (name !== "ms-character") return;
  release(); closeView(); setControls(true);
});
