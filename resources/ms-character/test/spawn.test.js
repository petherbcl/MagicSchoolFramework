"use strict";

// ms-character 0.6.0: delegation of the final position to ms-spawn (events), with a fake repository, game and core.
// No database. The default path (ms-spawn absent or not ready) is covered by the existing lobby/game tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLobby } = require("../server/lobby");
const { createGameAdapter } = require("../server/game");
const { loadConfig } = require("../server/config");

const config = loadConfig({}, { envFile: null });
const OVERLAND = { areaId: "Overland", x: 10, y: 20, z: 30, yaw: 40 };

function fixture({ location = OVERLAND, spawnReady = true, enterGame, throwOn = null, nativePlayer: native = null } = {}) {
  let now = 1000000;
  const character = { characterId: "1", userId: "1", firstName: "Ana", lastName: "Silva", house: "Ravenclaw", version: 1, lastPlayedAt: null,
    state: { inventory: [], look: null, location } };
  const repository = { ensureHouseRole: async () => ["ravenclaw"], list: async () => [character], get: async () => character, touch: async () => {}, save: async () => character,
    audit: async () => {}, };
  const sessions = new Map([[1, { sessionId: "s1", userId: "1", ready: true }]]);
  const events = [], sent = [], applied = [], released = [], entered = [], order = [];
  const core = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.get(id)?.ready === true },
    Players: { async enterGame(id, input) { order.push("enterGame"); if (enterGame) await enterGame(); entered.push({ id, ...input }); } } };
  const game = { enterLobby(p, l) { l.previous = {}; }, async settleLobby() { return true; }, release(p) { order.push("release"); released.push(p.id); }, cancel() {},
    send(p, name, payload) { if (payload.status === throwOn) throw new Error("player gone"); sent.push(payload.status); },
    kick() {}, async apply(p, c, isCurrent, token, destination) { order.push("apply"); applied.push({ status: isCurrent() ? "current" : "stale", destination }); },
    capture: (p, previous) => previous };
  // SEC-07: with a native player the real adapter's apply/release/cancel run (hold ownership modelled by the fake player).
  if (native) {
    const real = createGameAdapter(config);
    game.apply = async (...args) => { order.push("apply"); return real.apply(...args); };
    game.release = (p, l) => { order.push("release"); released.push(p.id); real.release(p, l); };
    game.cancel = l => real.cancel(l);
    game.complete = real.complete;
  }
  const flags = { ready: spawnReady, holds: true };
  const lobby = createLobby({ repository, config, game, core, spawn: { isReady: () => flags.ready, holds: () => flags.holds }, clock: () => (now += 1000),
    emit: (name, payload) => events.push({ name, payload }), logger: { error() {} } });
  const player = native || { id: 1, connected: true };
  const open = () => lobby.open(player, { sessionId: "s1", userId: "1" });
  const requested = () => events.filter(e => e.name === "ms:spawnSelectionRequested");
  const advance = ms => { now += ms; };
  return { game, advance, lobby, open, events, sent, applied, released, entered, order, sessions, flags, requested, character };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const DEST = { x: 1, y: 2, z: 3, yaw: 4 };

test("with ms-spawn ready the lobby holds in choosingSpawn and applies the destination from ms:spawnSelected", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  assert.deepEqual(f.requested().map(e => e.payload), [{ playerId: 1, sessionId: "s1", userId: "1", characterId: "1", last: { x: 10, y: 20, z: 30, yaw: 40 } }]);
  assert.equal(f.sent.at(-1), "choosingSpawn");
  assert.deepEqual([f.applied.length, f.released.length, f.entered.length], [0, 0, 0]);
  assert.equal(f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: { ...DEST, extra: 1 } }), true);
  await selecting;
  assert.deepEqual(f.applied, [{ status: "current", destination: DEST }]);
  assert.deepEqual(f.sent.slice(-3), ["choosingSpawn", "applying", "playing"]);
  assert.deepEqual(f.order, ["apply", "release", "enterGame"]);
  assert.equal(f.lobby.api.isPlaying(1), true);
  assert.equal(f.events.at(-1).name, "ms:characterReady");
});
test("ms-spawn absent or not ready: no event, no choosingSpawn, same destination as 0.5.0 (undefined)", async () => {
  const f = fixture({ spawnReady: false }); await f.open();
  await f.lobby.select(1, "1");
  assert.equal(f.requested().length, 0); assert.equal(f.sent.includes("choosingSpawn"), false);
  assert.deepEqual(f.applied, [{ status: "current", destination: undefined }]);
  const g = createLobby({ ...{ repository: { list: async () => [], get: async () => null }, config, game: { enterLobby(p, l) { l.previous = {}; }, async settleLobby() { return true; }, send() {}, cancel() {}, kick() {} },
    core: { Users: { get: () => ({ sessionId: "s1" }), isReady: () => true } }, logger: { error() {} } } }); // no `spawn` at all
  await g.open({ id: 1 }, { sessionId: "s1", userId: "1" });
});
test("a throwing probe counts as not ready", async () => {
  const f = fixture(); f.flags.ready = null; await f.open();
  await f.lobby.select(1, "1");
  assert.equal(f.requested().length, 0);
});
test("ms:spawnCancelled falls back to the default destination", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  assert.equal(f.lobby.spawnCancelled({ playerId: 1, sessionId: "s1", reason: "STOPPED" }), true);
  await selecting;
  assert.deepEqual(f.applied, [{ status: "current", destination: undefined }]);
  assert.equal(f.lobby.api.isPlaying(1), true);
});
test("a synchronous ms:spawnCancelled from the emit itself is not lost", async () => {
  const g = fixture(), seen = [];
  let lobby;
  lobby = createLobby({ repository: { ensureHouseRole: async () => [], list: async () => [g.character], get: async () => g.character, touch: async () => {}, save: async () => g.character, audit: async () => {} }, config,
    game: { enterLobby(p, l) { l.previous = {}; }, async settleLobby() { return true; }, release() {}, cancel() {}, send() {}, kick() {}, async apply(p, c, ok, t, d) { seen.push(["apply", d]); }, capture: (p, prev) => prev },
    core: { Users: { get: () => ({ sessionId: "s1" }), isReady: () => true }, Players: { async enterGame() {} } }, spawn: { isReady: () => true }, clock: () => 1e9,
    emit: (name, payload) => { if (name === "ms:spawnSelectionRequested") lobby.spawnCancelled({ playerId: payload.playerId, sessionId: payload.sessionId, reason: "NO_OPTIONS" }); },
    logger: { error() {} } });
  await lobby.open({ id: 1 }, { sessionId: "s1", userId: "1" });
  await lobby.select(1, "1");
  assert.deepEqual(seen, [["apply", undefined]]);
});
test("a stale ms:spawnSelected (wrong session, wrong player, wrong status, no wait) is ignored", async () => {
  const f = fixture(); await f.open();
  assert.equal(f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: DEST }), false); // status lobby
  const selecting = f.lobby.select(1, "1"); await tick();
  assert.equal(f.lobby.spawnSelected({ playerId: 1, sessionId: "other", destination: DEST }), false);
  assert.equal(f.lobby.spawnSelected({ playerId: 2, sessionId: "s1", destination: DEST }), false);
  assert.equal(f.lobby.spawnSelected({ playerId: "1", sessionId: "s1", destination: DEST }), false);
  assert.equal(f.lobby.spawnSelected(null), false);
  assert.equal(f.lobby.spawnCancelled({ playerId: 1, sessionId: "other", reason: "STOPPED" }), false);
  assert.equal(f.applied.length, 0);
  f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: DEST }); await selecting;
  assert.equal(f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: { x: 9, y: 9, z: 9, yaw: 9 } }), false); // already answered
  assert.deepEqual(f.applied.map(a => a.destination), [DEST]);
});
test("a malformed destination falls back to the default instead of leaving the player stuck", async () => {
  for (const destination of [{ x: NaN, y: 0, z: 0, yaw: 0 }, { x: 1 }, "x", null]) {
    const f = fixture(); await f.open();
    const selecting = f.lobby.select(1, "1"); await tick();
    f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination }); await selecting;
    assert.equal(f.applied[0].destination, undefined);
  }
});
test("(03.02) last is null unless the location is Overland with finite numbers; a missing yaw counts as 0", async () => {
  const cases = [[null, null], [{ areaId: "Castle", x: 1, y: 2, z: 3, yaw: 4 }, null], [{ areaId: "Overland", x: Infinity, y: 2, z: 3, yaw: 4 }, null],
    [{ areaId: "Overland", x: 1, y: 2, z: 3, yaw: "4" }, null], [{ areaId: "Overland", x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3, yaw: 0 }], [OVERLAND, { x: 10, y: 20, z: 30, yaw: 40 }]];
  for (const [location, expected] of cases) {
    const f = fixture({ location }); await f.open();
    f.lobby.select(1, "1").catch(() => {}); await tick();
    assert.deepEqual(f.requested()[0].payload.last, expected, JSON.stringify(location));
  }
});
test("(03.04) enterGame is never called before ms:spawnSelected, and never after a session end during choosingSpawn", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick(); await tick();
  assert.deepEqual(f.order, []); // no apply, release or enterGame while choosing
  await f.lobby.sessionEnded("s1");
  await assert.rejects(selecting, { code: "SESSION_EXPIRED" });
  assert.deepEqual(f.order, []); assert.equal(f.entered.length, 0);
  assert.equal(f.lobby.api.isPlaying(1), false);
  assert.equal(f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: DEST }), false);
  assert.deepEqual(f.order, []);
});
test("a disconnect during choosingSpawn releases the wait without applying anything", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  await f.lobby.disconnect(1);
  await assert.rejects(selecting, { code: "SESSION_EXPIRED" });
  assert.deepEqual(f.order, []);
});
test("stopping the lobby during choosingSpawn leaves no half-applied state", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  await f.lobby.stop();
  await assert.rejects(selecting);
  assert.deepEqual(f.order, []);
});
test("the session leaving ready during choosingSpawn makes a later answer fail closed", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  f.sessions.get(1).ready = false;
  assert.equal(f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: DEST }), false);
  await f.lobby.sessionEnded("s1"); await assert.rejects(selecting);
});
test("an apply failure after the spawn answer detaches the player (no half-applied state)", async () => {
  const f = fixture(); await f.open();
  const failing = createLobby({ repository: { ensureHouseRole: async () => [], list: async () => [f.character], get: async () => f.character, touch: async () => {}, save: async () => f.character, audit: async () => {} }, config,
    game: { enterLobby(p, l) { l.previous = {}; }, async settleLobby() { return true; }, release() {}, cancel() {}, send() {}, kick(p, reason) { f.order.push("kick:" + reason); }, async apply() { throw new Error("native"); }, capture: (p, prev) => prev },
    core: { Users: { get: () => ({ sessionId: "s1" }), isReady: () => true }, Players: { async enterGame() { f.order.push("enterGame"); } } }, spawn: { isReady: () => true }, clock: () => 1e9,
    emit: () => {}, logger: { error() {} } });
  await failing.open({ id: 1 }, { sessionId: "s1", userId: "1" });
  const selecting = failing.select(1, "1"); await tick();
  failing.spawnSelected({ playerId: 1, sessionId: "s1", destination: DEST });
  await assert.rejects(selecting, /native/);
  assert.deepEqual(f.order, ["kick:Não foi possível carregar a personagem."]);
  assert.equal(failing.api.isPlaying(1), false);
});
test("api.version is 0.6.0 everywhere", () => {
  const root = path.join(__dirname, "..");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.6.0");
  assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /versão 0\.6\.0/);
  assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /choosingSpawn/);
});

// ---- game.apply ----

function nativePlayer() {
  const calls = [];
  const player = { id: 1, connected: true,
    inventory: { replace(rows, done) { done(null, { revision: 1 }); }, waitForRevision() { return Promise.resolve({}); }, list: () => [] },
    location: () => ({ areaId: "Overland", x: 1, y: 2, z: 3, yaw: 4 }),
    release() {}, getLook: () => null, setSpawn(value) { calls.push(["spawn", value]); },
    teleport(x, y, z, options) { calls.push(["teleport", x, y, z, options]); return 42; } };
  return { player, calls };
}
test("game.apply uses the destination parameter instead of recomputing it", async () => {
  const game = createGameAdapter(config), { player, calls } = nativePlayer();
  const character = { house: "Ravenclaw", state: { inventory: [], look: null, location: { areaId: "Overland", x: 100, y: 200, z: 300, yaw: 5 } } };
  const applying = game.apply(player, character, () => true, 7, { x: 1, y: 2, z: 3, yaw: 90 });
  await tick(); await tick(); game.complete(1, "teleport", 42, 0); await applying;
  assert.deepEqual(calls, [["teleport", 1, 2, 3, { yaw: 90 }], ["spawn", { position: { x: 1, y: 2, z: 3 }, yaw: 90 }]]);
});
test("game.apply without a destination keeps the 0.5.0 behaviour (stored location, else the configured spawn)", async () => {
  for (const [location, expected] of [[{ areaId: "Overland", x: 100, y: 200, z: 300, yaw: 5 }, [100, 200, 300, { yaw: 5 }]],
    [null, [config.spawn.position.x, config.spawn.position.y, config.spawn.position.z, { yaw: config.spawn.yaw }]]]) {
    const game = createGameAdapter(config), { player, calls } = nativePlayer();
    const applying = game.apply(player, { house: "Ravenclaw", state: { inventory: [], look: null, location } }, () => true, 7);
    await tick(); await tick(); game.complete(1, "teleport", 42, 0); await applying;
    assert.deepEqual(calls[0], ["teleport", ...expected]);
  }
});

// ---- client script ----

test("client: choosingSpawn closes the page, keeps controls off and the page closed through applying until playing", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "..", "client", "main.js"), "utf8");
  const calls = [], handlers = {};
  const sandbox = { console, Date: { now: () => 0 }, setTimeout: () => 1, clearTimeout() {},
    Events: { on: (name, fn) => { handlers[name] = fn; }, emitServer() {} },
    Web: { createView: () => { calls.push("createView"); return 1; }, destroyView: () => calls.push("destroyView"), on() {}, emit() {}, getScreenSize: () => ({ width: 1920, height: 1080 }) },
    Game: { setPauseMenuEnabled: v => calls.push("pause:" + v), setActionScreenEnabled() {}, setToolWheelEnabled() {}, notify() {} },
    LocalPlayer: { stopPlayerInput: () => calls.push("input:off"), restorePlayerInput: () => calls.push("input:on") },
    Creator: {}, CreatorPreview: {} };
  vm.runInNewContext(SOURCE, sandbox, { filename: "client/main.js" });
  handlers["ms-character:state"]({ status: "loading", characters: [] });
  assert.ok(calls.includes("createView"));
  calls.length = 0;
  handlers["ms-character:state"]({ status: "choosingSpawn", characters: [] });
  assert.deepEqual(calls.filter(c => c !== "pause:false"), ["input:off", "destroyView"]);
  calls.length = 0;
  handlers["ms-character:state"]({ status: "applying", characters: [] });
  assert.equal(calls.includes("createView"), false, "the page stays closed during applying after a hand-over");
  handlers["ms-character:state"]({ status: "playing", characters: [] });
  assert.ok(calls.includes("input:on"));
  // Without a hand-over (ms-spawn absent) applying opens the page as before.
  calls.length = 0;
  handlers["ms-character:state"]({ status: "applying", characters: [] });
  assert.ok(calls.includes("createView"));
});

// ---- Security remediation (docs/security-audit-ms-spawn.md) -----------------------------------------------------------
test("SEC-02: a send that throws while entering choosingSpawn leaves no unhandled rejection", async () => {
  const seen = [], listener = error => seen.push(error);
  process.on("unhandledRejection", listener);
  try {
    const f = fixture({ throwOn: "choosingSpawn" }); await f.open();
    await assert.rejects(f.lobby.select(1, "1"), { message: "player gone" });
    for (let i = 0; i < 5; i++) await tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(seen, []);
    assert.equal(f.requested().length, 0); assert.equal(f.lobby.api.isPlaying(1), false);
  } finally { process.off("unhandledRejection", listener); }
});
test("SEC-03: ms-spawn gone (probe false) while choosingSpawn releases the player with the default destination", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  f.flags.ready = false; f.advance(6000);
  f.lobby.watchSpawn(); await selecting;
  assert.deepEqual(f.applied, [{ status: "current", destination: undefined }]);
  assert.equal(f.lobby.api.isPlaying(1), true);
});
test("SEC-03: ms-spawn reloaded and no longer holding the selection releases the player (saveAll tick)", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  f.flags.holds = false; f.advance(6000);
  await f.lobby.saveAll(); await selecting;
  assert.deepEqual(f.applied, [{ status: "current", destination: undefined }]);
  assert.equal(f.lobby.api.isPlaying(1), true);
});
test("SEC-03: a request younger than the grace is not judged lost", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  f.flags.holds = false; f.lobby.watchSpawn(); await tick();
  assert.equal(f.applied.length, 0); assert.equal(f.sent.at(-1), "choosingSpawn");
  f.lobby.spawnCancelled({ playerId: 1, sessionId: "s1", reason: "STOPPED" }); await selecting;
});
test("SEC-03: an idle player in a live ms-spawn is never released, however long it takes", async () => {
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  f.advance(24 * 3600 * 1000); await f.lobby.saveAll(); await tick();
  assert.equal(f.applied.length, 0); assert.equal(f.sent.at(-1), "choosingSpawn");
  f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: DEST }); await selecting;
  assert.deepEqual(f.applied.map(a => a.destination), [DEST]);
});
test("SEC-05: destinations beyond the coordinate bounds fall back to the default", async () => {
  for (const destination of [{ x: 1e7 + 1, y: 0, z: 0, yaw: 0 }, { x: 0, y: -1e9, z: 0, yaw: 0 }, { x: 0, y: 0, z: Infinity, yaw: 0 }, { x: 0, y: 0, z: 0, yaw: 361 }]) {
    const f = fixture(); await f.open();
    const selecting = f.lobby.select(1, "1"); await tick();
    f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination }); await selecting;
    assert.equal(f.applied[0].destination, undefined, JSON.stringify(destination));
  }
  const edge = { x: 1e7, y: -1e7, z: 0, yaw: -360 };
  const f = fixture(); await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  f.lobby.spawnSelected({ playerId: 1, sessionId: "s1", destination: edge }); await selecting;
  assert.deepEqual(f.applied[0].destination, edge);
});

// ---- SEC-07: ms-character releases ms-spawn's preview hold wherever it releases its own lobby hold ----

// Fake native player with hold ownership: a hold stays until its owner releases it.
function holdingPlayer(owners) {
  const holders = new Set(owners), calls = [];
  const base = nativePlayer().player;
  const player = { ...base, holders, release: owner => { calls.push(owner); return holders.delete(owner); },
    isVisible: () => true, isInvulnerable: () => false, getFastTravelEnabled: () => true,
    setVirtualWorld() {}, setVisible() {}, setInvulnerable() {}, setFastTravelEnabled() {},
    location: () => ({ areaId: "Overland", x: 1, y: 2, z: 3, yaw: 4 }) };
  return { player, holders, calls };
}
const PREVIEW = "ms-spawn:preview", LOBBY = "ms-character:lobby";
const stateOf = { house: "Ravenclaw", state: { inventory: [], look: null, location: null } };

test("SEC-07: apply after a preview hold orphaned by a lost ms-spawn leaves the player with no holds", async () => {
  const game = createGameAdapter(config), { player, holders } = holdingPlayer([PREVIEW]);
  const applying = game.apply(player, stateOf, () => true, 7);
  await tick(); await tick(); game.complete(1, "teleport", 42, 0); await applying;
  assert.deepEqual([...holders], []);
});
test("SEC-07: release and cancel also drop the preview hold; both owners go in one pass", () => {
  const game = createGameAdapter(config);
  let h = holdingPlayer([PREVIEW, LOBBY]);
  game.release(h.player, { previous: { visible: true, invulnerable: false, fastTravel: true } });
  assert.deepEqual([...h.holders], []); assert.deepEqual(h.calls, [LOBBY, PREVIEW]);
  h = holdingPlayer([PREVIEW]);
  game.cancel({ token: 1, player: h.player });
  assert.deepEqual([...h.holders], []);
});
test("SEC-07: without a preview hold the behaviour is unchanged (lobby hold released, the extra release is a harmless no-op)", () => {
  const game = createGameAdapter(config), h = holdingPlayer([LOBBY]);
  game.release(h.player, { previous: { visible: true, invulnerable: false, fastTravel: true } });
  assert.deepEqual([...h.holders], []);
});
test("SEC-07: the watchSpawn fallback (ms-spawn lost) ends with the orphaned preview hold released", async () => {
  const { player, holders } = holdingPlayer([PREVIEW]);
  const f = fixture({ nativePlayer: player });
  await f.open();
  const selecting = f.lobby.select(1, "1"); await tick();
  f.flags.ready = false; f.advance(6000);
  f.lobby.watchSpawn(); await tick(); await tick(); f.game.complete(1, "teleport", 42, 0); await selecting;
  assert.deepEqual([...holders], []); assert.equal(f.lobby.api.isPlaying(1), true);
});
