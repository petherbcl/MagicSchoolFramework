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
const look = () => ({ format: "arcanemp-look", version: 7, gender: "male", pronoun: "wizard", hood: false, gear: ["GA_Back_014"],
  presets: { skin: "s1", hairStyle: "h1" }, voice: { pitch: 0, tone: 0 } });
const brief = ({ characterId, firstName, lastName, house }) => ({ characterId, firstName, lastName, house });
const ana = { firstName: "Ana", lastName: "Silva", house: "Ravenclaw", look: look() };

test("a player without characters opens an empty lobby in a private world", async t => {
  const f = await fixture(t); await f.join();
  assert.deepEqual(f.state(1), { status: "lobby", characters: [], maxCharacters: 1, characterId: null });
  assert.equal(f.lobby.api.isPlaying(1), false); assert.deepEqual(f.released, []);
  assert.equal(f.events.at(-1).name, "ms:characterLobby");
});
test("create stores state with the sanitised look and rejects a missing or forged look", async t => {
  const f = await fixture(t); await f.join();
  const { characterId } = await f.lobby.create(1, ana);
  const stored = (await f.repository.get(characterId)).state;
  const { voice, ...rest } = look();
  assert.deepEqual(stored, { inventory: [], look: { ...rest, name: { first: "Ana", last: "Silva" }, house: "Ravenclaw" }, location: null });
  assert.equal(f.state(1).status, "lobby");
  f.advance(1000); await f.lobby.delete(1, characterId); f.advance(1000);
  const { look: _omit, ...noLook } = ana;
  await assert.rejects(f.lobby.create(1, noLook), { code: "INVALID_LOOK" }); f.advance(1000);
  await assert.rejects(f.lobby.create(1, { ...ana, look: { ...look(), gear: undefined } }), { code: "INVALID_LOOK" });
  assert.equal(f.state(1).status, "lobby");
  assert.equal((await f.repository.list("1")).length, 0);
  assert.equal(Number((await bootstrap.pool.query("SELECT count(*) AS n FROM ms_character.characters WHERE deleted_at IS NULL")).rows[0].n), 0);
});
test("creating a character returns to the lobby with it listed", async t => {
  const f = await fixture(t); await f.join();
  const created = await f.lobby.create(1, ana);
  assert.deepEqual(created, { characterId: "1", firstName: "Ana", lastName: "Silva", house: "Ravenclaw" });
  assert.equal(f.state(1).status, "lobby"); assert.deepEqual(f.state(1).characters.map(brief), [created]);
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
test("autosave retries transient failures and kicks only after three in a row", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  f.advance(1000); await f.lobby.select(1, characterId);
  const save = f.repository.save.bind(f.repository);
  let failing = true;
  f.repository.save = (...args) => failing ? Promise.reject(Object.assign(new Error("timeout"), { code: "57014" })) : save(...args);
  await f.lobby.saveAll(); await f.lobby.saveAll();
  assert.deepEqual(f.kicks, []); assert.equal(f.lobby.api.isPlaying(1), true);
  failing = false; await f.lobby.saveAll(); // success resets the counter
  failing = true; await f.lobby.saveAll(); await f.lobby.saveAll();
  assert.deepEqual(f.kicks, []);
  await f.lobby.saveAll();
  assert.match(f.kicks.at(-1).reason, /guardar a personagem/); assert.equal(f.lobby.api.isPlaying(1), false);
});
test("an autosave version conflict kicks at once", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  f.advance(1000); await f.lobby.select(1, characterId);
  const row = await f.repository.get(characterId);
  await f.repository.save(characterId, "1", row.version, { edited: true }); // changed outside the session
  await f.lobby.saveAll();
  assert.match(f.kicks.at(-1).reason, /alterada fora do jogo/);
  assert.deepEqual((await f.repository.get(characterId)).state, { edited: true });
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

// Soft delete (STORY-02.01): deleted_at NULL means active.
const softDelete = id => bootstrap.pool.query("UPDATE ms_character.characters SET deleted_at=now() WHERE id=$1", [id]);
test("schema creation adds deleted_at idempotently to an existing table", async () => {
  // Dropping the column also drops the partial index that depends on it.
  await bootstrap.pool.query("ALTER TABLE ms_character.characters DROP COLUMN deleted_at");
  await bootstrap.createSchema(); await bootstrap.createSchema();
  const columns = await bootstrap.pool.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='ms_character' AND table_name='characters' AND column_name='deleted_at'`);
  assert.equal(columns.rows[0].n, 1);
  assert.equal((await bootstrap.pool.query("SELECT to_regclass('ms_character.characters_user_active')::text AS i")).rows[0].i, "ms_character.characters_user_active");
  assert.equal((await bootstrap.pool.query("SELECT to_regclass('ms_character.characters_user')::text AS i")).rows[0].i, "ms_character.characters_user");
});
test("soft-deleted characters are hidden from the lobby list", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  const first = await f.lobby.create(1, ana); f.advance(1000);
  const second = await f.lobby.create(1, { ...ana, firstName: "Rita" });
  await softDelete(first.characterId);
  await f.join();
  assert.deepEqual(f.state(1).characters.map(brief), [second]);
  assert.deepEqual(await f.lobby.api.list(1), [second]);
});
test("soft-deleted characters do not count for the limit", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  const first = await f.lobby.create(1, ana); f.advance(1000);
  await f.lobby.create(1, { ...ana, firstName: "Rita" }); f.advance(1000);
  await softDelete(first.characterId);
  const third = await f.lobby.create(1, { ...ana, firstName: "Joana" });
  assert.equal(third.firstName, "Joana"); assert.equal(f.state(1).characters.length, 2);
});
test("a soft-deleted character cannot be selected", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  await softDelete(characterId);
  f.advance(1000); await assert.rejects(f.lobby.select(1, characterId), { code: "CHARACTER_NOT_FOUND" });
  assert.equal(f.state(1).status, "lobby"); assert.deepEqual(f.applied, []); assert.deepEqual(f.released, []);
});
test("get hides soft-deleted characters unless includeDeleted is set", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  await softDelete(characterId);
  assert.equal(await f.repository.get(characterId), null);
  assert.equal((await f.repository.get(characterId, { includeDeleted: true })).characterId, characterId);
  const row = (await bootstrap.pool.query("SELECT deleted_at FROM ms_character.characters WHERE id=$1", [characterId])).rows[0];
  assert.ok(row.deleted_at instanceof Date);
});
test("characters map lastPlayedAt as an ISO string or null", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  const never = await f.lobby.create(1, ana); f.advance(1000);
  const played = await f.lobby.create(1, { ...ana, firstName: "Rita" });
  await f.repository.touch(played.characterId);
  assert.equal((await f.repository.get(never.characterId)).lastPlayedAt, null);
  const { lastPlayedAt } = await f.repository.get(played.characterId);
  assert.equal(typeof lastPlayedAt, "string"); assert.equal(new Date(lastPlayedAt).toISOString(), lastPlayedAt);
});

// repository.delete (STORY-02.02): owner-only soft delete with an audit row in the same transaction.
const deletedAt = async id => (await bootstrap.pool.query("SELECT deleted_at FROM ms_character.characters WHERE id=$1", [id])).rows[0].deleted_at;
const deleteAudit = async () => (await bootstrap.pool.query(
  "SELECT actor,action,user_id,details FROM ms_core.ms_audit_log WHERE action='character.deleted' ORDER BY id")).rows;
test("repository.delete marks the owner's character and audits it", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  await f.repository.delete(characterId, "1");
  assert.ok(await deletedAt(characterId) instanceof Date);
  assert.deepEqual(await deleteAudit(), [{ actor: "user:1", action: "character.deleted", user_id: "1", details: { characterId } }]);
});
test("repository.delete refuses characters of another account", async t => {
  const f = await fixture(t); await f.join(2, "2"); const { characterId } = await f.lobby.create(2, ana);
  await assert.rejects(f.repository.delete(characterId, "1"), { code: "CHARACTER_NOT_FOUND" });
  assert.equal(await deletedAt(characterId), null); assert.deepEqual(await deleteAudit(), []);
});
test("repository.delete fails the second time without a second audit row", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  await f.repository.delete(characterId, "1");
  await assert.rejects(f.repository.delete(characterId, "1"), { code: "CHARACTER_NOT_FOUND" });
  assert.equal((await deleteAudit()).length, 1);
});
test("a failed audit insert rolls the delete back", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  const connect = f.repository.pool.connect.bind(f.repository.pool);
  f.repository.pool.connect = async () => {
    const client = await connect(), query = client.query.bind(client);
    client.query = (sql, ...args) => typeof sql === "string" && sql.includes("ms_audit_log") ? Promise.reject(new Error("audit failed")) : query(sql, ...args);
    // The pooled client is reused: undo the override when it goes back to the pool (release is pg-pool's own property).
    const release = client.release;
    client.release = (...args) => { delete client.query; client.release = release; return release.apply(client, args); };
    return client;
  };
  await assert.rejects(f.repository.delete(characterId, "1"), /audit failed/);
  f.repository.pool.connect = connect;
  assert.equal(await deletedAt(characterId), null); assert.deepEqual(await deleteAudit(), []);
});

// lobby.delete (STORY-02.03): only from "lobby", throttled, staleness-checked after every await.
test("deleting a character returns to the lobby without it and audits it", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  const first = await f.lobby.create(1, ana); f.advance(1000);
  const second = await f.lobby.create(1, { ...ana, firstName: "Rita" }); f.advance(1000);
  await f.lobby.delete(1, first.characterId);
  assert.equal(f.state(1).status, "lobby"); assert.deepEqual(f.state(1).characters.map(brief), [second]);
  assert.deepEqual((await deleteAudit()).map(row => row.details), [{ characterId: first.characterId }]);
});
test("deleting a character of another account changes nothing", async t => {
  const f = await fixture(t); await f.join(2, "2"); const { characterId } = await f.lobby.create(2, ana);
  await f.join(1, "1");
  await assert.rejects(f.lobby.delete(1, characterId), { code: "CHARACTER_NOT_FOUND" });
  assert.equal(f.state(1).status, "lobby"); assert.equal(await deletedAt(characterId), null); assert.deepEqual(await deleteAudit(), []);
});
test("deleting the same character twice fails the second time", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  f.advance(1000); await f.lobby.delete(1, characterId);
  f.advance(1000); await assert.rejects(f.lobby.delete(1, characterId), { code: "CHARACTER_NOT_FOUND" });
  assert.equal(f.state(1).status, "lobby"); assert.equal((await deleteAudit()).length, 1);
});
test("deleting outside the lobby status fails with INVALID_STATE", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  const { characterId } = await f.lobby.create(1, ana); f.advance(1000);
  const creating = f.lobby.create(1, { ...ana, firstName: "Rita" });
  await assert.rejects(f.lobby.delete(1, characterId), { code: "INVALID_STATE" });
  await creating; f.advance(1000);
  const applying = f.lobby.select(1, characterId);
  await assert.rejects(f.lobby.delete(1, characterId), { code: "INVALID_STATE" });
  await applying; f.advance(1000);
  assert.equal(f.state(1).status, "playing");
  await assert.rejects(f.lobby.delete(1, characterId), { code: "INVALID_STATE" });
  assert.equal(await deletedAt(characterId), null); assert.deepEqual(await deleteAudit(), []);
});
test("an unexpected repository error while deleting returns to the lobby", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  f.repository.delete = async () => { throw new Error("boom"); };
  f.advance(1000); await assert.rejects(f.lobby.delete(1, characterId), /boom/);
  assert.equal(f.state(1).status, "lobby"); assert.deepEqual(f.kicks, []);
});
test("deleting is throttled", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
  const first = await f.lobby.create(1, ana); f.advance(1000);
  const second = await f.lobby.create(1, { ...ana, firstName: "Rita" }); f.advance(1000);
  await f.lobby.delete(1, first.characterId);
  await assert.rejects(f.lobby.delete(1, second.characterId), { code: "RATE_LIMITED" });
  assert.equal(await deletedAt(second.characterId), null);
});
test("a lobby closed during a delete sends nothing to the old playerId", async t => {
  for (const close of [f => f.lobby.sessionEnded("s1"), f => f.lobby.disconnect(1)]) {
    const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
    const remove = f.repository.delete.bind(f.repository);
    f.repository.delete = async (...args) => { await remove(...args); f.sessions.delete(1); await close(f); };
    const before = f.sent.length;
    f.advance(1000); await assert.rejects(f.lobby.delete(1, characterId), { code: "SESSION_EXPIRED" });
    assert.equal(f.sent.length, before); assert.deepEqual(f.kicks, []);
  }
});
test("the ms-core session is re-checked after the delete await", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  const remove = f.repository.delete.bind(f.repository);
  f.repository.delete = async (...args) => { await remove(...args); f.sessions.set(1, { sessionId: "other", userId: "1", ready: true }); };
  f.advance(1000); await assert.rejects(f.lobby.delete(1, characterId), { code: "SESSION_EXPIRED" });
});
test("deleting frees a slot for a new character", async t => {
  const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
  f.advance(1000); await assert.rejects(f.lobby.create(1, { ...ana, firstName: "Rita" }), { code: "CHARACTER_LIMIT" });
  f.advance(1000); await f.lobby.delete(1, characterId);
  f.advance(1000); const rita = await f.lobby.create(1, { ...ana, firstName: "Rita" });
  assert.deepEqual(f.state(1).characters.map(brief), [rita]);
});
test("invalid character IDs are rejected before reaching the repository", async t => {
  const f = await fixture(t); await f.join(); let calls = 0;
  f.repository.delete = async () => { calls += 1; };
  for (const id of [null, { id: "1" }, "abc", "1".repeat(20)]) {
    f.advance(1000); await assert.rejects(f.lobby.delete(1, id), { code: "INVALID_ID" });
  }
  assert.equal(calls, 0); assert.equal(f.state(1).status, "lobby");
});

// main.js wiring (STORY-02.03): notices for delete and CHARACTER_LIMIT, never a kick. Uses fake runtime globals.
const DELETE_FAILED = "Não foi possível apagar a personagem. Tenta de novo; se o problema persistir, contacta a equipa.";
const LIMIT_REACHED = "Atingiste o limite de personagens. Apaga uma personagem para criares outra.";
async function until(condition, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) { assert.ok(Date.now() < end, "timed out waiting"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test("main.js maps delete failures and the character limit to notices without kicking", async () => {
  const keys = ["MS_DATABASE_URL", "MS_MAX_CHARACTERS", "MS_CHARACTER_POOL_SIZE", "MS_SAVE_INTERVAL_SECONDS"];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const { log, error } = console, prototypeDelete = Repository.prototype.delete;
  const on = {}, client = {}, sessions = new Map([[7, { sessionId: "s7", userId: "1" }]]);
  const notices = [], states = [], kicks = []; let deleteCalls = 0;
  const player = { id: 7, connected: true, isVisible: () => true, isInvulnerable: () => false, getFastTravelEnabled: () => true,
    setVirtualWorld() {}, setVisible() {}, setInvulnerable() {}, setFastTravelEnabled() {}, hold: () => true, release() {},
    emit(name, payload) { (name === "ms-character:notice" ? notices : states).push(JSON.parse(payload)); }, kick(reason) { kicks.push(reason); } };
  const core = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.has(id) } };
  Object.assign(process.env, { MS_DATABASE_URL: config.databaseUrl, MS_MAX_CHARACTERS: "1", MS_CHARACTER_POOL_SIZE: "1", MS_SAVE_INTERVAL_SECONDS: "300" });
  Object.assign(globalThis, {
    Events: { on: (name, fn) => { on[name] = fn; }, onClient: (name, fn) => { client[name] = fn; }, emit() {} },
    Exports: { get: (resource, name) => resource === "ms-core" && name === "Core" ? core : undefined, register: () => true },
    PlayerManager: { getById: id => id === 7 ? player : null, getAll: () => [] },
  });
  console.log = () => {}; console.error = () => {};
  Repository.prototype.delete = function (...args) { deleteCalls += 1; return prototypeDelete.apply(this, args); };
  try {
    await bootstrap.pool.query("INSERT INTO ms_character.characters(user_id,first_name,last_name,house) VALUES(1,'Ana','Silva','Ravenclaw')");
    require("../server/main");
    await on.resourceStart("ms-character");
    on["ms:playerReady"]({ playerId: 7, sessionId: "s7", userId: "1" });
    await until(() => states.at(-1)?.status === "lobby");
    // Payloads that fail the shape filter never reach the lobby.
    client["ms-character:delete"](player, { characterId: 1 }); client["ms-character:delete"](player, { characterId: "1".repeat(20) });
    // A delete while a create is in flight hits INVALID_STATE; the create itself hits the limit.
    client["ms-character:create"](player, ana); client["ms-character:delete"](player, { characterId: "1" });
    await until(() => notices.length >= 2);
    assert.deepEqual(notices.map(n => n.text).sort(), [DELETE_FAILED, LIMIT_REACHED].sort());
    assert.equal(deleteCalls, 0); assert.equal(await deletedAt("1"), null);
    await new Promise(resolve => setTimeout(resolve, 800)); // the throttle uses the real clock here
    Repository.prototype.delete = async () => { throw new Error("boom"); };
    client["ms-character:delete"](player, { characterId: "1" });
    await until(() => notices.length >= 3);
    assert.equal(notices[2].text, DELETE_FAILED); assert.equal(states.at(-1).status, "lobby");
    assert.deepEqual(kicks, []); assert.equal(notices.length, 3);
  } finally {
    Repository.prototype.delete = prototypeDelete;
    await on.resourceStop?.("ms-character");
    console.log = log; console.error = error;
    delete globalThis.Events; delete globalThis.Exports; delete globalThis.PlayerManager;
    for (const key of keys) if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
});

// STORY-03.04: LobbyCharacter payload (account owner only) and version 0.2.0.
test("the lobby state carries lastPlayedAt and look only for the owner, Characters.list stays a summary", async t => {
  const f = await fixture(t, {}, { maxCharacters: 2 });
  await f.join(1, "1"); await f.join(2, "2");
  const { characterId } = await f.lobby.create(1, ana);
  f.advance(1000); await f.lobby.select(1, characterId); await f.lobby.disconnect(1);
  f.sent.length = 0; await f.join(1, "1"); await f.join(2, "2");
  const states = f.sent.filter(v => v.name === "ms-character:state");
  assert.ok(states.some(v => v.playerId === 1 && v.payload.characters.length === 1));
  assert.ok(states.filter(v => v.playerId === 2).every(v => v.payload.characters.length === 0));
  const [entry] = f.state(1).characters;
  assert.deepEqual(Object.keys(entry).sort(), ["characterId", "firstName", "house", "lastName", "lastPlayedAt", "look"]);
  assert.match(entry.lastPlayedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(entry.look.name.first, "Ana"); assert.equal(entry.look.house, "Ravenclaw");
  assert.deepEqual(f.state(2).characters, []);
  const listed = await f.lobby.api.list(1);
  assert.deepEqual(listed.map(Object.keys), [["characterId", "firstName", "lastName", "house"]]);
  assert.equal("look" in listed[0], false);
});
test("a never-played character reports lastPlayedAt null", async t => {
  const f = await fixture(t); await f.join(); await f.lobby.create(1, ana);
  assert.equal(f.state(1).characters[0].lastPlayedAt, null);
});
test("the lobby state of a full account stays within 5 x 16 KB of look data", async t => {
  const f = await fixture(t, {}, { maxCharacters: 5 }); await f.join();
  for (let i = 0; i < 5; i++) { await f.lobby.create(1, { ...ana, firstName: "Ana" + "abcde"[i] }); f.advance(1000); }
  assert.ok(Buffer.byteLength(JSON.stringify(f.state(1))) <= 5 * 16 * 1024);
});
test("an old character with a null look still appears, can be selected and keeps the account look", async t => {
  const f = await fixture(t); await f.join();
  const { characterId } = await f.lobby.create(1, ana);
  await bootstrap.pool.query("UPDATE ms_character.characters SET state=jsonb_set(state,'{look}','null'::jsonb) WHERE id=$1", [characterId]);
  const setLook = []; let lookCalls = 0;
  const g = await fixture(t, { async apply(p, character) { if (character.state.look) lookCalls++; setLook.push(character.characterId); } });
  await g.join();
  const [entry] = g.state(1).characters;
  assert.equal(entry.look, null); assert.equal(entry.characterId, characterId);
  assert.equal(entry.firstName, "Ana"); assert.equal(entry.house, "Ravenclaw");
  g.advance(1000); await g.lobby.select(1, characterId);
  assert.equal(g.state(1).status, "playing"); assert.equal(g.lobby.api.isPlaying(1), true);
  assert.deepEqual(setLook, [characterId]); assert.equal(lookCalls, 0);
  assert.equal(g.kicks.length, 0);
});
test("game.apply does not call setLook when state.look is null", async () => {
  const { createGameAdapter } = require("../server/game");
  const game = createGameAdapter(config); let looks = 0;
  const player = { id: 1, connected: true, inventory: { replace(rows, done) { done(null, { revision: 1 }); }, waitForRevision: () => Promise.resolve({}) },
    location: () => ({ areaId: "Overland", x: 1, y: 2, z: 3 }), release() {}, setLook() { looks++; }, setSpawn() {},
    teleport() { return 5; } };
  const restoring = game.apply(player, { house: "Ravenclaw", state: { inventory: [], look: null, location: null } }, () => true, 1);
  await new Promise(resolve => setImmediate(resolve)); game.complete(1, "teleport", 5, 0); await restoring;
  assert.equal(looks, 0);
});
test("version 0.2.0 matches package.json, api.version and the README", async t => {
  const f = await fixture(t);
  const fs = require("node:fs"), path = require("node:path");
  const pkg = require("../package.json"), readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.equal(f.lobby.api.version, "0.2.0"); assert.equal(pkg.version, "0.2.0"); assert.match(readme, /versão 0\.2\.0/);
});
