"use strict";

// Client script for ms-character. See docs/architecture-plan.md §4.4 (page <-> client contract) and §5.4 (lobby preview).
// One Creator session at a time, shared by the lobby preview and the creator. Creator.cancel() does NOT revert
// (findings §2), so every release goes through release(), which restores originalLook first.

const PREVIEW_DEBOUNCE_MS = 80;
const SCHEMA_POLL_MS = 50;
const COMMIT_REPLY_TIMEOUT_MS = 150;
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
let schemaTimer = null, schemaToken = 0;

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
  CreatorPreview.setCamera({ ...base, shift: base.shift * (width / REFERENCE_WIDTH) });
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
  commitTimer = cancelTimer(commitTimer); commitPending = 0;
  patchTimer = cancelTimer(patchTimer); pendingPatch = null;
  schemaTimer = cancelTimer(schemaTimer); schemaToken++;
}

// Idempotent. Only touches what this resource acquired.
function release() {
  clearTimers();
  creatorOpen = false; pronoun = null;
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
  if (!force && !consistent(schema, Creator.getState())) return null;
  return {
    capabilities: Creator.getCapabilities(),
    categories: Object.keys(schema.categories).map(id => ({ id, options: schema.categories[id].options })),
    state: Creator.getState(),
  };
}

function deliverSchema(force) {
  const payload = attempt("buildSchema", () => buildSchema(force));
  if (!payload) return false;
  sendToPage("creator:schema", payload);
  return true;
}

function failCreator(code) {
  schemaTimer = cancelTimer(schemaTimer); schemaToken++;
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
  if (session !== null) {
    // Shared session from the lobby: the previewed card look must not leak into the creator.
    if (!attempt("importLook(originalLook)", () => Creator.importLook(session.originalLook))) { failCreator("CREATOR_BEGIN_FAILED"); return; }
    if (!attempt("Creator.isActive", () => Creator.isActive()) && attempt("begin", () => Creator.begin({ preserveCurrent: true })) !== true) {
      release(); failCreator("CREATOR_BEGIN_FAILED"); return;
    }
  } else if (!attempt("open creator session", acquire)) {
    release(); failCreator("CREATOR_BEGIN_FAILED"); return;
  }
  creatorOpen = true; pronoun = null;
  sendSchemaWhenReady();
}

function cancelCreator() {
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
  applyPatchNow("preset", payload.preset);
  // The schema IDs change with the body: resend it once getSchema() agrees with getState().
  sendSchemaWhenReady(true);
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
  const look = pronoun ? { ...exported, pronoun } : exported;
  Events.emitServer("ms-character:create", { ...request, look });
  release();
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

function flush() { if (pageReady && view !== null && lastState) Web.emit(view, "state", lastState); }
function closeView() {
  if (view !== null) Web.destroyView(view);
  view = null; pageReady = false;
}
function show(state) {
  lastState = state;
  if (state.status === "playing") { release(); closeView(); setControls(true); return; }
  setControls(false);
  if (view === null) {
    view = Web.createView("fw://resources/ms-character/client/ui/index.html", { focus: true });
    Web.on(view, "ready", () => { pageReady = true; flush(); if (lastState && lastState.status === "lobby") openLobbySession(); });
    Web.on(view, "create", onCreate);
    Web.on(view, "select", onSelect);
    Web.on(view, "delete", payload => Events.emitServer("ms-character:delete", payload));
    Web.on(view, "camera:frame", payload => { if (payload && typeof payload === "object") attempt("camera:frame", () => setFrame(payload.framing)); });
    Web.on(view, "lobby:preview", onLobbyPreview);
    Web.on(view, "creator:begin", beginCreator);
    Web.on(view, "creator:cancel", cancelCreator);
    Web.on(view, "creator:patch", onPatch);
    Web.on(view, "creator:body", onBody);
    Web.on(view, "creator:pronoun", onPronoun);
  }
  flush();
  // Back in the lobby after a failed select/create: the session was released, so open it again.
  if (pageReady && state.status === "lobby") openLobbySession();
}

Events.on("creatorChanged", state => {
  if (session === null || !creatorOpen) return;
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
