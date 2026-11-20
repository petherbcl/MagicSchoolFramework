"use strict";

const { check, clone, CharacterError } = require("./validation");
const HOLD = "ms-character:lobby";
// A bit longer than the game's own 20 s ground wait, so a slow but healthy teleport is not reported as failed.
const LOBBY_GROUND_TIMEOUT_MS = 25000;
// Owner tag of ms-spawn's preview hold (part of the ms-spawn contract). ms-character releases it wherever it releases HOLD, so
// a preview hold orphaned by a crashed or reloaded ms-spawn can never keep clamping a released player (SEC-07).
// Releasing an owner that holds nothing is harmless (returns false).
const SPAWN_PREVIEW_HOLD = "ms-spawn:preview";
const releaseHolds = player => { player.release(HOLD); player.release(SPAWN_PREVIEW_HOLD); };

// Native side of the lobby: private world while choosing, then restore and release.
// Async native operations resolve through requestIds (playerTeleportComplete /
// playerMapTravelComplete) or callbacks, always with a timeout.
function createGameAdapter(config, { setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  const pending = new Map();
  const lookFailed = new Set(); // players whose stored look the game rejected: capture() keeps the stored one
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
  function travel(player, token, type, action, timeoutMs = 90000) {
    return wait(token, (done, entry) => {
      entry.playerId = player.id; entry.type = type;
      entry.requestId = action();
      check(Number.isInteger(entry.requestId) && entry.requestId > 0, "TRAVEL_REFUSED");
    }, timeoutMs);
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
    // Lobby spawn: the game's own ground wait. A same-area teleport with snapToGround holds a player on foot where they land
    // until the floor under them loads (up to 20 s) and playerTeleportComplete reports groundSnapped. Resolves true only
    // then; any failure, timeout or lost session resolves false (the caller never blocks the player on it). The lobby hold
    // is off during the teleport (it would clamp the landing) and goes back on at the landing point, or at the anchor.
    async settleLobby(player, lobby) {
      const anchor = { ...config.lobby.position };
      let landed = null;
      try {
        player.release(HOLD);
        const completion = await travel(player, lobby.token, "teleport", () => player.teleport(anchor.x, anchor.y, anchor.z,
          { yaw: config.lobby.yaw || 0, snapToGround: true }), LOBBY_GROUND_TIMEOUT_MS);
        const at = completion?.destination;
        if (completion?.groundSnapped === true && at && [at.x, at.y, at.z].every(Number.isFinite)) landed = { x: at.x, y: at.y, z: at.z };
        else if (completion?.groundSnapped === true) landed = anchor;
      } catch { landed = null; }
      if (player.connected) player.hold({ owner: HOLD, ...(landed || anchor), mode: "clamp", radius: 0, radiusZ: 0, ttlMs: 0 });
      return landed !== null;
    },
    send(player, eventName, payload) { player.emit(eventName, JSON.stringify(payload)); },
    kick(player, reason) { player.kick(reason); },
    // `chosen` is the destination ms-spawn confirmed; without it the character's last Overland position (or the default spawn) is used.
    async apply(player, character, isCurrent, token, chosen) {
      const ensure = () => check(isCurrent() && player.connected, "SESSION_EXPIRED");
      ensure();
      const position = character.state.location?.areaId === "Overland" ? character.state.location : null;
      const destination = chosen || position || { ...config.spawn.position, yaw: config.spawn.yaw };
      // Stay in the private world and invisible while loading, but allow the native travel.
      releaseHolds(player);
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
      lookFailed.delete(player.id);
      if (character.state.look) {
        // A look the game rejects (an asset ID it does not know, a removed asset) must not lock the character out:
        // log it and play with the current look. The stored look is kept untouched (see capture).
        try { await callback(token, done => player.setLook(character.state.look, done)); }
        catch (error) {
          if (error?.code === "SESSION_EXPIRED") throw error;
          lookFailed.add(player.id);
          console.error("[ms-character] setLook failed, keeping the stored look: " + (error?.code || error?.name || "UNKNOWN"));
        }
        ensure();
      }
      player.house = character.house;
      await travel(player, token, "teleport", () => player.teleport(destination.x, destination.y, destination.z, { yaw: destination.yaw || 0 }));
      ensure();
      player.setSpawn({ position: { x: destination.x, y: destination.y, z: destination.z }, yaw: destination.yaw || 0 });
    },
    release(player, lobby) {
      releaseHolds(player);
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
        look: lookFailed.has(player.id) ? previous.look || null : player.getLook() || previous.look || null,
        location: usable ? { areaId: location.areaId, x: location.x, y: location.y, z: location.z, yaw: location.yaw } : kept,
      });
    },
    complete(playerId, type, requestId, status, completion) {
      for (const entry of pending.values()) {
        if (entry.playerId === playerId && entry.type === type && entry.requestId === requestId) {
          entry.finish(status === 0 ? null : new CharacterError("TRAVEL_FAILED"), status === 0 ? completion : undefined);
          break;
        }
      }
    },
    cancel(lobby) {
      for (const entry of [...pending.values()]) if (entry.token === lobby.token) entry.finish(new CharacterError("SESSION_EXPIRED"));
      releaseHolds(lobby.player);
      lookFailed.delete(lobby.player.id);
    },
  };
}

module.exports = { createGameAdapter };
