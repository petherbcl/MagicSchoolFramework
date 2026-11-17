"use strict";

let view = null, pageReady = false, lastState = null, pendingCredential = null;

function flush() {
  if (pageReady && view !== null && lastState) Web.emit(view, "session", lastState);
  if (pageReady && view !== null && pendingCredential) Web.emit(view, "credential", pendingCredential);
}
function closeView() {
  if (view !== null) Web.destroyView(view);
  view = null; pageReady = false;
}
function show(state) {
  lastState = state;
  if (state.status === "ready") {
    closeView();
    LocalPlayer.restorePlayerInput();
    Game.setPauseMenuEnabled(true);
    Game.setActionScreenEnabled(true);
    Game.setToolWheelEnabled(true);
    return;
  }
  LocalPlayer.stopPlayerInput();
  Game.setPauseMenuEnabled(false);
  Game.setActionScreenEnabled(false);
  Game.setToolWheelEnabled(false);
  if (view === null) {
    view = Web.createView("fw://resources/ms-core/client/ui/index.html", { focus: true });
    Web.on(view, "ready", () => { pageReady = true; flush(); });
    Web.on(view, "register", payload => Events.emitServer("ms-core:register", payload));
    Web.on(view, "credentialStored", payload => {
      pendingCredential = null;
      Events.emitServer("ms-core:credentialStored", payload);
    });
  }
  flush();
}

Events.on("ms-core:session", state => {
  if (!state || typeof state !== "object" || typeof state.status !== "string") return;
  show(state);
});
Events.on("ms-core:credential", payload => {
  if (!payload || typeof payload.sessionId !== "string" || typeof payload.credential !== "string") return;
  pendingCredential = payload; flush();
});
Events.on("ms-core:notice", value => {
  if (!value || typeof value.text !== "string") return;
  Game.notify(value.text);
  if (pageReady && view !== null) Web.emit(view, "notice", { text: value.text });
});
Events.on("resourceStart", name => { if (name === "ms-core") Events.emitServer("ms-core:sync"); });
Events.on("worldReady", () => Events.emitServer("ms-core:sync"));
Events.on("resourceStop", name => {
  if (name !== "ms-core") return;
  closeView();
  LocalPlayer.restorePlayerInput();
  Game.setPauseMenuEnabled(true);
  Game.setActionScreenEnabled(true);
  Game.setToolWheelEnabled(true);
});
