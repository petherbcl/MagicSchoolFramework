"use strict";

let view = null, pageReady = false, lastState = null;

function setControls(enabled) {
  if (enabled) LocalPlayer.restorePlayerInput(); else LocalPlayer.stopPlayerInput();
  Game.setPauseMenuEnabled(enabled);
  Game.setActionScreenEnabled(enabled);
  Game.setToolWheelEnabled(enabled);
}
function flush() { if (pageReady && view !== null && lastState) Web.emit(view, "state", lastState); }
function closeView() {
  if (view !== null) Web.destroyView(view);
  view = null; pageReady = false;
}
function show(state) {
  lastState = state;
  if (state.status === "playing") { closeView(); setControls(true); return; }
  setControls(false);
  if (view === null) {
    view = Web.createView("fw://resources/ms-character/client/ui/index.html", { focus: true });
    Web.on(view, "ready", () => { pageReady = true; flush(); });
    Web.on(view, "create", payload => Events.emitServer("ms-character:create", payload));
    Web.on(view, "select", payload => Events.emitServer("ms-character:select", payload));
  }
  flush();
}

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
  closeView(); setControls(true);
});
