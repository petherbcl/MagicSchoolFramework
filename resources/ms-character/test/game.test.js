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
test("capture keeps the last Overland position outside Overland or while loading", () => {
  const game = createGameAdapter(config), { player } = nativePlayer();
  const previous = { location: { areaId: "Overland", x: 9, y: 8, z: 7, yaw: 6 } };
  assert.deepEqual(game.capture(player, previous).location, { areaId: "Overland", x: 1, y: 2, z: 3, yaw: 4 });
  player.location = () => ({ areaId: "Hogwarts", x: 1, y: 2, z: 3, yaw: 4 });
  assert.deepEqual(game.capture(player, previous).location, previous.location);
  player.location = () => null;
  assert.deepEqual(game.capture(player, previous).location, previous.location);
  assert.equal(game.capture(player, { location: { areaId: "Hogwarts", x: 1, y: 2, z: 3, yaw: 4 } }).location, null);
});
test("restore stops when its lobby is cancelled", async () => {
  const game = createGameAdapter(config), { player } = nativePlayer();
  player.inventory.replace = () => {};
  const restoring = game.apply(player, { state: { inventory: [] } }, () => true, 9);
  game.cancel({ token: 9, player });
  await assert.rejects(restoring, { code: "SESSION_EXPIRED" });
});

test("a look the game rejects does not stop the restore and the stored look is kept on capture (L-07)", async () => {
  const game = createGameAdapter(config), { player } = nativePlayer();
  player.setLook = (look, done) => done(new Error("unknown asset"));
  player.getLook = () => ({ marker: "default" });
  const stored = { marker: "stored" };
  const restoring = game.apply(player, { house: "Ravenclaw", state: { inventory: [], look: stored, location: null } }, () => true, 3);
  await new Promise(resolve => setImmediate(resolve));
  game.complete(1, "teleport", 42, 0); await restoring;
  assert.deepEqual(game.capture(player, { look: stored }).look, stored, "the default look must not overwrite the stored one");
});

test("settleLobby uses the game's ground wait and re-holds the player at the landing point", async () => {
  const game = createGameAdapter(config), { player } = nativePlayer();
  const holds = [], released = [], teleports = [];
  player.hold = options => { holds.push(options); return true; }; player.release = owner => { released.push(owner); };
  player.teleport = (x, y, z, options) => { teleports.push({ x, y, z, options }); return 77; };
  const settling = game.settleLobby(player, { token: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, ["ms-character:lobby"], "the lobby hold would clamp the landing");
  assert.equal(teleports[0].options.snapToGround, true);
  assert.deepEqual({ x: teleports[0].x, y: teleports[0].y, z: teleports[0].z }, config.lobby.position);
  game.complete(1, "teleport", 77, 0, { groundSnapped: true, destination: { x: 5, y: 6, z: 7, yaw: 0 } });
  assert.equal(await settling, true);
  assert.deepEqual({ x: holds[0].x, y: holds[0].y, z: holds[0].z, owner: holds[0].owner }, { x: 5, y: 6, z: 7, owner: "ms-character:lobby" });
});
test("settleLobby resolves false, still re-holds at the anchor and never throws when the ground is not confirmed", async () => {
  for (const finish of [
    (game) => game.complete(1, "teleport", 8, 0, { groundSnapped: false, destination: null }),
    (game) => game.complete(1, "teleport", 8, 4, undefined),
  ]) {
    const game = createGameAdapter(config), { player } = nativePlayer(); const holds = [];
    player.hold = options => { holds.push(options); return true; }; player.teleport = () => 8;
    const settling = game.settleLobby(player, { token: 1 });
    await new Promise(resolve => setImmediate(resolve)); finish(game);
    assert.equal(await settling, false);
    assert.deepEqual({ x: holds[0].x, y: holds[0].y, z: holds[0].z }, config.lobby.position);
  }
  const game = createGameAdapter(config), { player } = nativePlayer(); player.teleport = () => { throw new Error("native"); };
  assert.equal(await game.settleLobby(player, { token: 1 }), false);
});
