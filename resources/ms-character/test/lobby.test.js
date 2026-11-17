"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
const coreSchema = require("../../ms-core/server/database/schema");
const { Repository } = require("../server/database/repository");
const { createLobby } = require("../server/lobby");
const { loadConfig } = require("../server/config");
let engine, server, bootstrap, config;

before(async () => {
  engine = await PGlite.create();
  server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 8 });
  await server.start();
  config = { ...loadConfig({}), databaseUrl: "postgresql://postgres:postgres@" + server.getServerConn() + "/postgres", databaseConfigured: true, poolSize: 1 };
  bootstrap = new Repository(config);
  await bootstrap.pool.query(coreSchema); await bootstrap.createSchema();
});
after(async () => { await bootstrap?.close(); await server?.stop(); await engine?.close(); });
beforeEach(async () => {
  await bootstrap.pool.query("TRUNCATE ms_character.characters, ms_core.ms_users RESTART IDENTITY CASCADE");
  await bootstrap.pool.query("INSERT INTO ms_core.ms_users DEFAULT VALUES"); await bootstrap.pool.query("INSERT INTO ms_core.ms_users DEFAULT VALUES");
});

async function fixture(t, overrides = {}, settings = {}) {
  let now = 1000000;
  const repository = new Repository(config), sent = [], kicks = [], events = [], applied = [], released = [], sessions = new Map();
  const core = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.get(id)?.ready === true } };
  const game = { enterLobby(p, l) { l.previous = {}; }, release(p) { released.push(p.id); }, cancel() {},
    send(p, name, payload) { sent.push({ playerId: p.id, name, payload }); },
    kick(p, reason) { kicks.push({ playerId: p.id, reason }); },
    async apply(p, character) { applied.push({ playerId: p.id, character }); },
    capture(p, previous) { return { ...previous, inventory: [{ item: "saved-" + p.id }] }; }, ...overrides };
  const lobby = createLobby({ repository, config: { ...config, ...settings }, game, core, clock: () => now,
    emit: (name, payload) => events.push({ name, payload }), logger: { error() {} } });
  t.after(async () => { await lobby.stop(); await repository.close(); });
  const player = id => ({ id, connected: true });
  async function join(id = 1, userId = "1") {
    sessions.set(id, { sessionId: "s" + id, userId, ready: true });
    await lobby.open(player(id), { sessionId: "s" + id, userId });
  }
  const state = id => sent.filter(v => v.playerId === id && v.name === "ms-character:state").at(-1)?.payload;
  return { lobby, repository, sent, kicks, events, applied, released, sessions, player, join, state, advance(ms) { now += ms; } };
}
const ana = { firstName: "Ana", lastName: "Silva", house: "Ravenclaw" };

test("a player without characters opens an empty lobby in a private world", async t => {
  const f = await fixture(t); await f.join();
  assert.deepEqual(f.state(1), { status: "lobby", characters: [], maxCharacters: 1, characterId: null });
  assert.equal(f.lobby.api.isPlaying(1), false); assert.deepEqual(f.released, []);
  assert.equal(f.events.at(-1).name, "ms:characterLobby");
});
test("creating a character returns to the lobby with it listed", async t => {
  const f = await fixture(t); await f.join();
  const created = await f.lobby.create(1, ana);
  assert.deepEqual(created, { characterId: "1", firstName: "Ana", lastName: "Silva", house: "Ravenclaw" });
  assert.equal(f.state(1).status, "lobby"); assert.deepEqual(f.state(1).characters, [created]);
  const audit = (await f.repository.pool.query("SELECT action,user_id FROM ms_core.ms_audit_log")).rows;
  assert.deepEqual(audit, [{ action: "character.created", user_id: "1" }]);
});
test("character input and the per-account limit are validated", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  await assert.rejects(f.lobby.create(1, { ...ana, firstName: "1" }), { code: "INVALID_NAME" });
  f.advance(1000); await assert.rejects(f.lobby.create(1, { ...ana, house: "Durmstrang" }), { code: "INVALID_HOUSE" });
  f.advance(1000); await f.lobby.create(1, ana);
  await assert.rejects(f.lobby.create(1, ana), { code: "RATE_LIMITED" });
  f.advance(1000); await f.lobby.create(1, { ...ana, firstName: "Rita" });
  f.advance(1000); await assert.rejects(f.lobby.create(1, ana), { code: "CHARACTER_LIMIT" });
  assert.equal(f.state(1).status, "lobby"); assert.equal(f.state(1).characters.length, 2);
});
test("selecting a character restores it, releases the lobby and emits ms:characterReady", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  f.advance(1000); await f.lobby.select(1, characterId);
  assert.equal(f.applied[0].character.characterId, characterId); assert.deepEqual(f.released, [1]);
  assert.equal(f.lobby.api.isPlaying(1), true); assert.equal(f.state(1).status, "playing");
  assert.deepEqual(f.events.at(-1), { name: "ms:characterReady", payload: { playerId: 1, sessionId: "s1", userId: "1", characterId } });
  const row = await f.repository.get(characterId);
  assert.ok(row.version >= 1); assert.deepEqual(row.state.inventory, [{ item: "saved-1" }]);
  assert.equal(f.lobby.api.getSelected(1).characterId, characterId);
});
test("characters of another account cannot be selected", async t => {
  const f = await fixture(t); await f.join(1, "1"); const { characterId } = await f.lobby.create(1, ana);
  await f.join(2, "2");
  await assert.rejects(f.lobby.select(2, characterId), { code: "CHARACTER_NOT_FOUND" });
  assert.equal(f.state(2).status, "lobby"); assert.deepEqual(f.applied, []);
  f.advance(1000); await assert.rejects(f.lobby.select(2, "abc"), { code: "INVALID_ID" });
});
test("a failed native restore kicks the player and never emits ready", async t => {
  const f = await fixture(t, { async apply() { throw new Error("native failed"); } });
  await f.join(); const { characterId } = await f.lobby.create(1, ana);
  f.advance(1000); await assert.rejects(f.lobby.select(1, characterId));
  assert.match(f.kicks.at(-1).reason, /carregar a personagem/);
  assert.equal(f.events.some(e => e.name === "ms:characterReady"), false);
  assert.equal((await f.repository.get(characterId)).version, 0);
});
test("the ms-core session is re-checked after every await", async t => {
  const f = await fixture(t); await f.join();
  f.sessions.set(1, { sessionId: "other", userId: "1", ready: true });
  await assert.rejects(f.lobby.create(1, ana), { code: "SESSION_EXPIRED" });
  assert.equal(f.lobby.api.isPlaying(1), false);
});
test("disconnecting saves a playing character; lobby players save nothing", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  await f.lobby.disconnect(1); assert.equal((await f.repository.get(characterId)).version, 0);
  await f.join(); await f.lobby.select(1, characterId);
  const version = (await f.repository.get(characterId)).version;
  await f.lobby.disconnect(1);
  assert.equal((await f.repository.get(characterId)).version, version + 1);
  assert.equal(f.lobby.api.getSelected(1), null);
});
test("the last played character is listed first", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  const first = await f.lobby.create(1, ana); f.advance(1000);
  const second = await f.lobby.create(1, { ...ana, firstName: "Rita" }); f.advance(1000);
  await f.lobby.select(1, second.characterId); await f.lobby.disconnect(1);
  await f.join();
  assert.deepEqual(f.state(1).characters.map(c => c.characterId), [second.characterId, first.characterId]);
});
test("stale saves are rejected by version", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  const row = await f.repository.get(characterId);
  await f.repository.save(characterId, "1", row.version, { marker: 1 });
  await assert.rejects(f.repository.save(characterId, "1", row.version, { marker: 2 }), { code: "REVISION_CONFLICT" });
});
test("schema creation requires ms-core and keeps existing data", async () => {
  await bootstrap.createSchema();
  assert.equal((await bootstrap.pool.query("SELECT count(*)::int AS n FROM ms_core.ms_users")).rows[0].n, 2);
});
test("configuration reads ms-core's .env as a fallback for the database", () => {
  const cfg = loadConfig({ MS_MAX_CHARACTERS: "3" }, { envFile: null, coreEnvFile: null });
  assert.equal(cfg.databaseConfigured, false); assert.equal(cfg.maxCharacters, 3);
  assert.throws(() => loadConfig({ MS_MAX_CHARACTERS: "9" }), /MS_MAX_CHARACTERS/);
});
