"use strict";

const { check, clone, CharacterError } = require("./validation");
const HOLD = "ms-character:lobby";

// Native side of the lobby: private world while choosing, then restore and release.
// Async native operations resolve through requestIds (playerTeleportComplete /
// playerMapTravelComplete) or callbacks, always with a timeout.
function createGameAdapter(config, { setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  const pending = new Map();
  function wait(token, action, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const key = Symbol("native");
      const finish = (error, value) => {
        const item = pending.get(key);
        if (!item) return;
        cancel(item.timer); pending.delete(key);
        if (error) reject(error); else resolve(value);
      };
      const timer = later(() => finish(new CharacterError("NATIVE_TIMEOUT")), timeoutMs);
      pending.set(key, { token, timer, finish });
      try { action(finish, pending.get(key)); } catch (error) { finish(error); }
    });
  }
  function callback(token, action) {
    return wait(token, done => action((error, result) => done(error ? new CharacterError(error.code || "NATIVE_APPLY_FAILED") : null, result)));
  }
  function travel(player, token, type, action) {
    return wait(token, (done, entry) => {
      entry.playerId = player.id; entry.type = type;
      entry.requestId = action();
      check(Number.isInteger(entry.requestId) && entry.requestId > 0, "TRAVEL_REFUSED");
    }, 90000);
  }
  return {
    enterLobby(player, lobby) {
      if (!lobby.previous) lobby.previous = {
        visible: player.isVisible(), invulnerable: player.isInvulnerable(), fastTravel: player.getFastTravelEnabled(),
      };
      player.setVirtualWorld(lobby.world);
      player.setVisible(false);
      player.setInvulnerable(true);
      player.setFastTravelEnabled(false);
      // Fixed anchors must not use rigid: that option requires an anchorId.
      check(player.hold({ owner: HOLD, ...config.lobby.position, mode: "clamp", radius: 0, radiusZ: 0, ttlMs: 0 }), "HOLD_FAILED");
    },
    send(player, eventName, payload) { player.emit(eventName, JSON.stringify(payload)); },
    kick(player, reason) { player.kick(reason); },
    async apply(player, character, isCurrent, token) {
      const ensure = () => check(isCurrent() && player.connected, "SESSION_EXPIRED");
      ensure();
      const position = character.state.location?.areaId === "Overland" ? character.state.location : null;
      const destination = position || { ...config.spawn.position, yaw: config.spawn.yaw };
      // Stay in the private world and invisible while loading, but allow the native travel.
      player.release(HOLD);
      if (player.location()?.areaId !== "Overland") {
        await travel(player, token, "map", () => player.travelToMap("/Game/Levels/Overland/Overland", {
          position: { x: destination.x, y: destination.y, z: destination.z }, yaw: destination.yaw || 0,
        }));
        ensure();
      }
      const result = await callback(token, done => player.inventory.replace(character.state.inventory || [], done));
      ensure();
      check(Number.isInteger(result?.revision), "INVALID_INVENTORY_REVISION");
      await wait(token, done => player.inventory.waitForRevision(result.revision).then(value => done(null, value), done));
      ensure();
      if (character.state.look) {
        await callback(token, done => player.setLook(character.state.look, done));
        ensure();
      }
      player.house = character.house;
      await travel(player, token, "teleport", () => player.teleport(destination.x, destination.y, destination.z, { yaw: destination.yaw || 0 }));
      ensure();
      player.setSpawn({ position: { x: destination.x, y: destination.y, z: destination.z }, yaw: destination.yaw || 0 });
    },
    release(player, lobby) {
      player.release(HOLD);
      player.setVirtualWorld(0);
      player.setVisible(lobby.previous.visible);
      player.setInvulnerable(lobby.previous.invulnerable);
      player.setFastTravelEnabled(lobby.previous.fastTravel);
    },
    capture(player, previous) {
      // apply() can only restore Overland positions, so inside other areas (castle, dungeons, during
      // loads) keep the last Overland position instead of overwriting it with one we cannot use.
      const location = player.location();
      const usable = location?.areaId === "Overland" && [location.x, location.y, location.z, location.yaw].every(Number.isFinite);
      const kept = previous.location?.areaId === "Overland" ? previous.location : null;
      return clone({
        inventory: player.inventory.list(),
        look: player.getLook() || previous.look || null,
        location: usable ? { areaId: location.areaId, x: location.x, y: location.y, z: location.z, yaw: location.yaw } : kept,
      });
    },
    complete(playerId, type, requestId, status) {
      for (const entry of pending.values()) {
        if (entry.playerId === playerId && entry.type === type && entry.requestId === requestId) {
          entry.finish(status === 0 ? null : new CharacterError("TRAVEL_FAILED"));
          break;
        }
      }
    },
    cancel(lobby) {
      for (const entry of [...pending.values()]) if (entry.token === lobby.token) entry.finish(new CharacterError("SESSION_EXPIRED"));
      lobby.player.release(HOLD);
    },
  };
}

module.exports = { createGameAdapter };
