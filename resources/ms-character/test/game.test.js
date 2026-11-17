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
const config = loadConfig({}, { envFile: null, coreEnvFile: null });

test("the lobby uses a private world and a fixed hold", () => {
  const game = createGameAdapter(config), { player, calls } = nativePlayer();
  let anchor; player.hold = options => { anchor = options; return true; };
  game.enterLobby(player, { world: 3100000001 });
  assert.equal(anchor.owner, "ms-character:lobby"); assert.equal(anchor.rigid, undefined);
  assert.ok(calls.some(call => Array.isArray(call) && call[1] === 3100000001));
});
test("restore waits for inventory, look and teleport acknowledgement", async () => {
  const game = createGameAdapter(config), { player, calls } = nativePlayer();
  const character = { house: "Ravenclaw", state: { inventory: [], look: { marker: true }, location: { areaId: "Overland", x: 1, y: 2, z: 3 } } };
  let finished = false;
  const restoring = game.apply(player, character, () => true, 7).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.deepEqual(calls, ["replace", "revision", "look", "teleport"]);
  game.complete(1, "teleport", 42, 0); await restoring;
  assert.equal(player.house, "Ravenclaw");
});
test("a new character without location goes to the configured spawn", async () => {
  const game = createGameAdapter(config), { player } = nativePlayer();
  let target; player.teleport = (x, y, z) => { target = { x, y, z }; return 5; };
  const restoring = game.apply(player, { house: "Hufflepuff", state: { inventory: [], look: null, location: null } }, () => true, 1);
  await new Promise(resolve => setImmediate(resolve));
  game.complete(1, "teleport", 5, 0); await restoring;
  assert.deepEqual(target, config.spawn.position);
});
test("restore stops when its lobby is cancelled", async () => {
  const game = createGameAdapter(config), { player } = nativePlayer();
  player.inventory.replace = () => {};
  const restoring = game.apply(player, { state: { inventory: [] } }, () => true, 9);
  game.cancel({ token: 9, player });
  await assert.rejects(restoring, { code: "SESSION_EXPIRED" });
});
