"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGameAdapter } = require("../server/game");
const { loadConfig } = require("../server/config");

function nativePlayer() {
  const calls = [];
  const player = {
    id: 1, connected: true,
    inventory: { replace(rows, done) { calls.push("replace"); done(null, { revision: 1 }); }, waitForRevision() { calls.push("revision"); return Promise.resolve({}); }, list: () => [] },
    location: () => ({ areaId: "Overland", x: 1, y: 2, z: 3, yaw: 4 }),
    isVisible: () => true, isInvulnerable: () => false, getFastTravelEnabled: () => true,
    setVirtualWorld(value) { calls.push(["world", value]); }, setVisible() {}, setInvulnerable() {}, setFastTravelEnabled() {},
    hold: () => true, release() {}, getLook: () => null, setSpawn() {},
    setLook(look, done) { calls.push("look"); done(null, {}); },
    teleport() { calls.push("teleport"); return 42; },
  };
  return { player, calls };
}

test("native restore waits for inventory, look and teleport acknowledgement", async () => {
  const game = createGameAdapter(loadConfig({})), { player, calls } = nativePlayer();
  const character = { house: "Ravenclaw", state: { inventory: [], look: { marker: true }, location: { areaId: "Overland", x: 1, y: 2, z: 3 } } };
  let finished = false;
  const restoring = game.apply(player, character, () => true, "session").then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(calls, ["replace", "revision", "look", "teleport"]);
  game.complete(1, "teleport", 42, 0);
  await restoring;
  assert.equal(player.house, "Ravenclaw");
});

test("native restore stops when its session is cancelled", async () => {
  const game = createGameAdapter(loadConfig({})), { player } = nativePlayer();
  player.inventory.replace = () => {};
  const restoring = game.apply(player, { state: { inventory: [] } }, () => true, "session");
  game.cancel({ sessionId: "session", player });
  await assert.rejects(restoring, { code: "SESSION_EXPIRED" });
});

test("a failed native inventory revision prevents character readiness", async () => {
  const game = createGameAdapter(loadConfig({})), { player } = nativePlayer();
  player.inventory.waitForRevision = () => Promise.reject(new Error("native apply failed"));
  await assert.rejects(game.apply(player, { state: { inventory: [] } }, () => true, "session"));
});

test("authentication uses a fixed hold compatible with the native anchor contract", () => {
  const game = createGameAdapter(loadConfig({})), { player, calls } = nativePlayer();
  let anchor;
  player.hold = options => { anchor = options; return !options.rigid || Number.isInteger(options.anchorId); };
  game.restrict(player, { world: 3000000001 });
  assert.equal(anchor.mode, "clamp");
  assert.equal(anchor.owner, "ms-core:authentication");
  assert.equal(anchor.rigid, undefined);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "world" && call[1] === 3000000001));
});
