"use strict";

const { check, clone, CoreError } = require("./validation");
const HOLD = "ms-core:authentication";

function createGameAdapter(config, { setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  const pending = new Map();
  function wait(sessionId, action, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const key = Symbol(sessionId);
      const finish = (error, value) => {
        const item = pending.get(key);
        if (!item) return;
        cancel(item.timer); pending.delete(key);
        if (error) reject(error); else resolve(value);
      };
      const timer = later(() => finish(new CoreError("NATIVE_TIMEOUT")), timeoutMs);
      pending.set(key, { sessionId, timer, finish });
      try { action(finish, pending.get(key)); } catch (error) { finish(error); }
    });
  }
  async function callback(sessionId, action) {
    return wait(sessionId, done => action((error, result) => done(error ? new CoreError(error.code || "NATIVE_APPLY_FAILED") : null, result)));
  }
  async function travel(player, sessionId, type, action) {
    return wait(sessionId, (done, entry) => {
      entry.playerId = player.id; entry.type = type;
      entry.requestId = action();
      check(Number.isInteger(entry.requestId) && entry.requestId > 0, "TRAVEL_REFUSED");
    }, 90000);
  }
  const adapter = {
    restrict(player, session) {
      if (!session.previous) session.previous = {
        visible: player.isVisible(), invulnerable: player.isInvulnerable(),
        fastTravel: player.getFastTravelEnabled(),
      };
      player.setVirtualWorld(session.world);
      player.setVisible(false);
      player.setInvulnerable(true);
      player.setFastTravelEnabled(false);
      const position = config.spawn.position;
      // Fixed anchors must not use rigid: that option requires an anchorId.
      check(player.hold({ owner: HOLD, ...position, mode: "clamp", radius: 0, radiusZ: 0, ttlMs: 0 }), "HOLD_FAILED");
    },
    send(player, eventName, payload) { player.emit(eventName, JSON.stringify(payload)); },
    kick(player, reason) { player.kick(reason); },
    async apply(player, character, isCurrent, sessionId) {
      const ensure = () => check(isCurrent() && player.connected, "SESSION_EXPIRED");
      ensure();
      const position = character.state.location?.areaId === "Overland" ? character.state.location : null;
      const destination = position || { ...config.spawn.position, yaw: config.spawn.yaw };
      // Keep the private world and invisibility while loading, but allow the native travel.
      player.release(HOLD);
      if (player.location()?.areaId !== "Overland") {
        await travel(player, sessionId, "map", () => player.travelToMap("/Game/Levels/Overland/Overland", {
          position: { x: destination.x, y: destination.y, z: destination.z }, yaw: destination.yaw || 0,
        }));
        ensure();
      }
      const result = await callback(sessionId, done => player.inventory.replace(character.state.inventory || [], done));
      ensure();
      check(Number.isInteger(result?.revision), "INVALID_INVENTORY_REVISION");
      await wait(sessionId, done => player.inventory.waitForRevision(result.revision).then(value => done(null, value), done));
      ensure();
      if (character.state.look) {
        await callback(sessionId, done => player.setLook(character.state.look, done));
        ensure();
      }
      player.house = character.house;
      if (position) {
        await travel(player, sessionId, "teleport", () => player.teleport(position.x, position.y, position.z, { yaw: position.yaw || 0 }));
        ensure();
      }
      player.setSpawn({ position: { x: destination.x, y: destination.y, z: destination.z }, yaw: destination.yaw || 0 });
    },
    release(player, session) {
      player.release(HOLD);
      player.setVirtualWorld(0);
      player.setVisible(session.previous.visible);
      player.setInvulnerable(session.previous.invulnerable);
      player.setFastTravelEnabled(session.previous.fastTravel);
    },
    capture(player, previous) {
      const location = player.location();
      const finiteLocation = location && [location.x, location.y, location.z, location.yaw].every(Number.isFinite);
      return clone({
        inventory: player.inventory.list(),
        look: player.getLook() || previous.look || null,
        location: finiteLocation ? {
          areaId: location.areaId, x: location.x, y: location.y, z: location.z, yaw: location.yaw,
        } : previous.location || null,
      });
    },
    complete(playerId, type, requestId, status) {
      for (const entry of pending.values()) {
        if (entry.playerId === playerId && entry.type === type && entry.requestId === requestId) {
          entry.finish(status === 0 ? null : new CoreError("TRAVEL_FAILED"));
          break;
        }
      }
    },
    cancel(session) {
      for (const entry of [...pending.values()]) {
        if (entry.sessionId === session.sessionId) entry.finish(new CoreError("SESSION_EXPIRED"));
      }
      session.player.release(HOLD);
    },
  };
  return adapter;
}

module.exports = { createGameAdapter };
