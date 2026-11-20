"use strict";

// Native/CEF side of ms-spawn. Sends payloads to the client script and, since CHG-01, moves and holds the invisible
// quarantined player at the selected point so the world streams in around the camera. It never releases the player into
// world 0 (that stays in ms-character). Server -> client payloads are always JSON strings.
const PREVIEW_OWNER = "ms-spawn:preview";
const LOBBY_OWNER = "ms-character:lobby"; // owned by ms-character; released here only after PREVIEW_OWNER holds the player
// Longer than the game's own 20 s ground wait for snapToGround, so a slow but healthy teleport is not reported as failed.
const TELEPORT_TIMEOUT_MS = 25000;
// Safety net only: a hold of a resource that crashed without cleanup expires. Every normal exit releases it explicitly.
const HOLD_TTL_MS = 30 * 60 * 1000;
const finite = value => typeof value === "number" && Number.isFinite(value);

function createGameAdapter({ getPlayer, setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout, teleportTimeoutMs = TELEPORT_TIMEOUT_MS, logger = console }) {
  const alive = playerId => { const player = getPlayer(playerId); return player && player.connected !== false ? player : null; };
  const emit = (playerId, name, payload) => {
    const player = alive(playerId);
    if (player) player.emit(name, JSON.stringify(payload));
  };
  // One pending teleport per player: a newer one supersedes the older (the game does the same: status 1).
  const pending = new Map();
  function settle(playerId, result) {
    const entry = pending.get(playerId);
    if (!entry) return false;
    pending.delete(playerId); cancel(entry.timer); entry.resolve(result);
    return true;
  }
  // SEC-10: Player.teleport has no cancel. A request dropped by us (selection closed, superseded, timeout) may still land:
  // its request id is remembered (bounded, oldest evicted) so the late result is recognised, ignored and logged (never applied to state).
  const abandoned = new Set();
  const ABANDONED_MAX = 64;
  function abandon(playerId, entry) {
    if (!entry || entry.requestId === null) return;
    abandoned.add(playerId + ":" + entry.requestId);
    if (abandoned.size > ABANDONED_MAX) abandoned.delete(abandoned.values().next().value);
  }
  function drop(playerId) {
    abandon(playerId, pending.get(playerId));
    return settle(playerId, { result: "replaced" });
  }
  const holdAt = (player, point) => player.hold({ owner: PREVIEW_OWNER, x: point.x, y: point.y, z: point.z, mode: "clamp", radius: 0, radiusZ: 0, ttlMs: HOLD_TTL_MS }) === true;

  return {
    open: (playerId, payload) => emit(playerId, "ms-spawn:open", payload),
    state: (playerId, payload) => emit(playerId, "ms-spawn:state", payload),

    // Take the player over from ms-character's lobby hold without ever leaving them unheld: the new hold goes on at the
    // player's current position first, and only then is the lobby hold released. Returns false (nothing changed, the lobby
    // hold stays) when the position is unreadable or the game refuses the second hold.
    takeover(playerId) {
      const player = alive(playerId);
      const at = player && player.location();
      if (!at || !finite(at.x) || !finite(at.y) || !finite(at.z)) return false;
      if (!holdAt(player, at)) return false;
      player.release(LOBBY_OWNER);
      return true;
    },
    // Hold at `point`, or at the player's current position when `point` is null. Returns whether the hold is on.
    hold(playerId, point) {
      const player = alive(playerId);
      if (!player) return false;
      const at = point || player.location();
      if (!at || !finite(at.x) || !finite(at.y) || !finite(at.z)) return false;
      return holdAt(player, at);
    },
    release(playerId) {
      const player = alive(playerId);
      if (player) player.release(PREVIEW_OWNER);
    },
    // Resolves { result: "ok" | "replaced" | "failed" | "timeout", status? } from playerTeleportComplete (0 ok, 1 replaced by
    // a newer teleport, 2..5 failed). Rejects only if the player is gone. A call while another is pending supersedes it.
    teleport(playerId, point) {
      const player = alive(playerId);
      if (!player) return Promise.reject(new Error("PLAYER_GONE"));
      drop(playerId);
      return new Promise(resolve => {
        const entry = { requestId: null, resolve, timer: later(() => { abandon(playerId, pending.get(playerId)); settle(playerId, { result: "timeout" }); }, teleportTimeoutMs) };
        pending.set(playerId, entry);
        try {
          const requestId = player.teleport(point.x, point.y, point.z, { yaw: point.yaw || 0, snapToGround: true });
          if (!Number.isInteger(requestId) || requestId <= 0) settle(playerId, { result: "failed", status: null });
          else entry.requestId = requestId;
        } catch { settle(playerId, { result: "failed", status: null }); }
      });
    },
    // Drops the pending teleport of this player (selection closed). Its promise resolves "replaced" and is ignored by the caller.
    // The native request keeps running (no cancel API): see `abandoned`.
    cancelTeleport: playerId => drop(playerId),
    // playerTeleportComplete. Unknown ids (ms-character's own teleports, stale requests) are ignored.
    complete(playerId, requestId, status) {
      const key = playerId + ":" + requestId;
      if (abandoned.has(key)) {
        abandoned.delete(key);
        if (status === 0) logger.error("[ms-spawn] a teleport landed after its selection moved on or closed (ignored)");
        return false;
      }
      const entry = pending.get(playerId);
      if (!entry || entry.requestId !== requestId) return false;
      return settle(playerId, status === 0 ? { result: "ok", status } : status === 1 ? { result: "replaced", status } : { result: "failed", status });
    },
  };
}

module.exports = { createGameAdapter, PREVIEW_OWNER, LOBBY_OWNER };
