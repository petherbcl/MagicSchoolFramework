"use strict";

const NOCLIP_EVENT = "ms-admin:noclip";
const round = value => Math.round(value * 100) / 100;

// Pure command handler. `core` is ms-core's Core, `game` the native adapter and `chat` sends a line to one player.
// Every command needs the configured role AND a player that is in the game with a character.
function createAdmin({ config, core, game, chat }) {
  const noclip = new Map(); // playerId -> { sessionId, previous }

  // The role is re-read from ms-core on every call (it follows the polled user row), never cached here.
  function authorized(playerId) {
    const entry = core.Players.get(playerId);
    return Boolean(entry && entry.roles.includes(config.role));
  }

  function turnOff(player) {
    const state = noclip.get(player.id);
    noclip.delete(player.id);
    game.stopFx(player, state && state.fx);
    game.show(player, state && state.previous);
    game.emit(player, NOCLIP_EVENT, { enabled: false });
  }

  const commands = {
    nc(player) {
      if (noclip.has(player.id)) { turnOff(player); chat(player, "Noclip desligado."); return; }
      const entry = core.Players.get(player.id);
      noclip.set(player.id, { sessionId: entry.sessionId, previous: game.hide(player), fx: game.startFx(player) });
      game.emit(player, NOCLIP_EVENT, { enabled: true });
      chat(player, "Noclip ligado.");
    },
    // /fxlist [filter]: lists Fx.catalog() entries so staff can pick MS_ADMIN_NOCLIP_FX.
    fxlist(player, args) {
      const list = game.fxCatalog(args[0]);
      if (!list.length) { chat(player, "Nenhum efeito encontrado."); return; }
      chat(player, `${list.length} efeitos (a mostrar ${Math.min(list.length, 10)}):`);
      for (const entry of list.slice(0, 10)) chat(player, entry.path);
    },
    coords(player) {
      const at = game.position(player);
      if (!at) { chat(player, "Posição indisponível."); return; }
      chat(player, `x: ${round(at.x)}, y: ${round(at.y)}, z: ${round(at.z)}, w: ${round(at.yaw)}`);
    },
  };

  return {
    // True when the command exists and ran. Unauthorized players get no reply, so staff commands are not advertised.
    handle(player, command, args = []) {
      if (!Object.hasOwn(commands, command)) return false;
      if (!authorized(player.id)) return false;
      commands[command](player, args);
      return true;
    },
    isNoclip: playerId => noclip.has(playerId),
    // The player left the game, disconnected or lost the role: undo native changes.
    clear(player) { if (noclip.has(player.id)) turnOff(player); },
    // Noclip must not outlive the role or the character session.
    revalidate(getPlayer) {
      for (const [playerId, state] of [...noclip]) {
        const entry = core.Players.get(playerId);
        const player = getPlayer(playerId);
        if (player && entry && entry.sessionId === state.sessionId && entry.roles.includes(config.role)) continue;
        if (player) turnOff(player); else noclip.delete(playerId);
      }
    },
  };
}
module.exports = { createAdmin, NOCLIP_EVENT };
