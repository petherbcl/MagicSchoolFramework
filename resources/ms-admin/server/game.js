"use strict";

const SMOKE = /smoke|fumo|dark.?mist|dementor|death.?eater|shadow/i;

// Native adapter: visibility and collision are set on the server, free movement runs in the client script.
// Effects are cosmetic, so every failure here is swallowed: noclip must still work without them.
function createGameAdapter(config = {}, { fxApi = () => globalThis.Fx, log = console } = {}) {
  let warned = false;
  function catalog() { try { return fxApi()?.catalog() || []; } catch { return []; } }
  function pickPath() {
    if (config.noclipFx) return config.noclipFx;
    const found = catalog().find(entry => SMOKE.test(entry.name) || SMOKE.test(entry.path));
    if (!found && !warned) { warned = true; log.warn("[ms-admin] no smoke effect found; set MS_ADMIN_NOCLIP_FX (use /fxlist)"); }
    return found ? found.path : null;
  }
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
    // Smoke attached to the player; returns a handle for stopFx, or null when no effect could be created.
    startFx(player) {
      if (config.noclipFxEnabled === false) return { fx: null };
      try {
        if (config.noclipSkinFx) player.setSkinFx(config.noclipSkinFx);
        const path = pickPath();
        const Fx = fxApi();
        if (!path || !Fx) return { fx: null };
        const key = "ms-admin:nc:" + player.id;
        const at = player.location();
        const fx = Fx.create(key, path, { x: at?.x, y: at?.y, z: at?.z });
        if (fx) fx.attachTo(player, { z: 0 });
        return { fx: fx ? key : null };
      } catch { return { fx: null }; }
    },
    stopFx(player, handle) {
      try { if (config.noclipSkinFx) player.setSkinFx(null); } catch { /* handle no longer usable */ }
      try { if (handle && handle.fx) fxApi()?.destroy(handle.fx); } catch { /* already gone */ }
    },
    fxCatalog(filter) {
      const needle = String(filter || "").toLowerCase();
      return catalog().filter(entry => !needle || (entry.name + " " + entry.path).toLowerCase().includes(needle));
    },
    emit(player, name, payload) { try { player.emit(name, JSON.stringify(payload)); } catch { /* disconnected */ } },
    position(player) { return player.location(); },
  };
}
module.exports = { createGameAdapter };
