"use strict";

// Native adapter: visibility and collision are set on the server, free movement runs in the client script.
function createGameAdapter() {
  return {
    hide(player) {
      const previous = { visible: player.isVisible(), collidable: player.isCollidable() };
      player.setVisible(false);
      player.setCollidable(false);
      return previous;
    },
    show(player, previous) {
      try {
        player.setVisible(previous ? previous.visible : true);
        player.setCollidable(previous ? previous.collidable : true);
      } catch { /* handle no longer usable */ }
    },
    emit(player, name, payload) { try { player.emit(name, JSON.stringify(payload)); } catch { /* disconnected */ } },
    position(player) { return player.location(); },
  };
}
module.exports = { createGameAdapter };
