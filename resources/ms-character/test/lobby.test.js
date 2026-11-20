"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Repository } = require("../server/database/repository");
const { schemaFor } = require("../server/database/schema");
const { createLobby } = require("../server/lobby");
const { loadConfig } = require("../server/config");
const { DIALECTS, startDb } = require("./helpers/sql");

// The suite runs once per SQL dialect; MySQL and MariaDB are skipped (with the reason) unless their
// MS_SQL_TEST_*_URL variable points at a real server. State JSON is always passed explicitly (no JSON DEFAULT on MySQL).
const EMPTY_STATE = JSON.stringify({ inventory: [], look: null, location: null });

for (const target of DIALECTS) describe(target.name, { skip: target.skip }, () => {
  let db, sql, bootstrap;
  const mysqlFamily = target.name !== "postgres";
  const config = loadConfig({});
  before(async () => { db = await startDb(target); sql = db.sql; bootstrap = new Repository(sql); await bootstrap.createTables(); });
  after(async () => { await db?.stop(); });
  beforeEach(async () => { await db.resetTables(); await db.seedUsers(2); });

  async function fixture(t, overrides = {}, settings = {}) {
    let now = 1000000;
    const repository = new Repository(sql), sent = [], kicks = [], events = [], applied = [], released = [], sessions = new Map(), entered = [];
    const core = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.get(id)?.ready === true },
      Players: { async enterGame(id, input) { if (overrides.enterGame) await overrides.enterGame(id, input); entered.push({ playerId: id, ...input }); } } };
    const game = { enterLobby(p, l) { l.previous = {}; }, async settleLobby() { return true; }, release(p) { released.push(p.id); }, cancel() {},
      send(p, name, payload) { sent.push({ playerId: p.id, name, payload }); },
      kick(p, reason) { kicks.push({ playerId: p.id, reason }); },
      async apply(p, character) { applied.push({ playerId: p.id, character }); },
      capture(p, previous) { return { ...previous, inventory: [{ item: "saved-" + p.id }] }; }, ...overrides, enterGame: undefined };
    const lobby = createLobby({ repository, config: { ...config, ...settings }, game, core, clock: () => now,
      emit: (name, payload) => events.push({ name, payload }), logger: { error() {} } });
    t.after(async () => { await lobby.stop(); });
    const player = id => ({ id, connected: true });
    async function join(id = 1, userId = "1") {
      sessions.set(id, { sessionId: "s" + id, userId, ready: true });
      await lobby.open(player(id), { sessionId: "s" + id, userId });
    }
    const state = id => sent.filter(v => v.playerId === id && v.name === "ms-character:state").at(-1)?.payload;
    return { lobby, repository, sent, kicks, events, applied, released, entered, sessions, player, join, state, advance(ms) { now += ms; } };
  }
  const look = () => ({ format: "arcanemp-look", version: 7, gender: "male", pronoun: "wizard", hood: false, gear: ["GA_Back_014"],
    presets: { skin: "s1", hairStyle: "h1" }, voice: { pitch: 0, tone: 0 } });
  const brief = ({ characterId, firstName, lastName, house }) => ({ characterId, firstName, lastName, house });
  const ana = { firstName: "Ana", lastName: "Silva", house: "Ravenclaw", look: look() };

  test("a player without characters opens an empty lobby in a private world", async t => {
    const f = await fixture(t); await f.join();
    assert.deepEqual(f.state(1), { status: "lobby", characters: [], maxCharacters: 1, characterId: null, groundSnapped: true });
    assert.equal(f.lobby.api.isPlaying(1), false); assert.deepEqual(f.released, []);
    assert.equal(f.events.at(-1).name, "ms:characterLobby");
  });
  test("create stores state with the sanitised look and rejects a missing or forged look", async t => {
    const f = await fixture(t); await f.join();
    const { characterId } = await f.lobby.create(1, ana);
    const stored = (await f.repository.get(characterId)).state;
    assert.deepEqual(stored, { inventory: [], look: { ...look(), name: { first: "Ana", last: "Silva" }, house: "Ravenclaw" }, location: null });
    assert.equal(f.state(1).status, "lobby");
    f.advance(1000); await f.lobby.delete(1, characterId); f.advance(1000);
    const { look: _omit, ...noLook } = ana;
    await assert.rejects(f.lobby.create(1, noLook), { code: "INVALID_LOOK" }); f.advance(1000);
    await assert.rejects(f.lobby.create(1, { ...ana, look: { ...look(), gear: undefined } }), { code: "INVALID_LOOK" });
    assert.equal(f.state(1).status, "lobby");
    assert.equal((await f.repository.list("1")).length, 0);
    assert.equal(Number(await sql.scalar("SELECT count(*) FROM ms_characters WHERE deleted_at IS NULL")), 0);
  });
  test("creating a character returns to the lobby with it listed", async t => {
    const f = await fixture(t); await f.join();
    const created = await f.lobby.create(1, ana);
    assert.deepEqual(created, { characterId: "1", firstName: "Ana", lastName: "Silva", house: "Ravenclaw" });
    assert.equal(f.state(1).status, "lobby"); assert.deepEqual(f.state(1).characters.map(brief), [created]);
    const audit = await sql.query("SELECT action,user_id FROM ms_audit_log");
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
  test("selecting a character tells ms-core the player enters the game, before ms:characterReady", async t => {
    const f = await fixture(t); await f.join(); const { characterId } = await f.lobby.create(1, ana);
    f.advance(1000); await f.lobby.select(1, characterId);
    assert.deepEqual(f.entered, [{ playerId: 1, sessionId: "s1", characterId }]);
  });
  test("when ms-core refuses the game entry the player is kicked and ms:characterReady is never emitted", async t => {
    const f = await fixture(t, { async enterGame() { throw Object.assign(new Error("refused"), { code: "INVALID_SESSION_STATE" }); } });
    await f.join(); const { characterId } = await f.lobby.create(1, ana);
    f.advance(1000); await assert.rejects(f.lobby.select(1, characterId));
    assert.match(f.kicks.at(-1).reason, /carregar a personagem/);
    assert.equal(f.events.some(e => e.name === "ms:characterReady"), false);
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
    await bootstrap.createTables();
    assert.equal(Number(await sql.scalar("SELECT count(*) FROM ms_users")), 2);
  });
  // Soft delete (STORY-02.01): deleted_at NULL means active.
  const softDelete = id => sql.update("UPDATE ms_characters SET deleted_at=CURRENT_TIMESTAMP(3) WHERE id=?", [id]);
  test("table creation is idempotent, lands in the configured schema and keeps both indexes", async () => {
    await bootstrap.createTables(); await bootstrap.createTables();
    const current = mysqlFamily ? "DATABASE()" : "current_schema()";
    const columns = await sql.scalar(`SELECT count(*) FROM information_schema.columns
      WHERE table_schema=${current} AND table_name='ms_characters' AND column_name='deleted_at'`);
    assert.equal(Number(columns), 1);
    assert.equal(Number(await sql.scalar(`SELECT count(*) FROM information_schema.tables WHERE table_schema=${current} AND table_name='characters'`)), 0, "the old unprefixed name is not used");
    const indexes = await sql.query(mysqlFamily
      ? "SELECT DISTINCT index_name AS n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ms_characters'"
      : "SELECT indexname AS n FROM pg_indexes WHERE schemaname=current_schema() AND tablename='ms_characters'");
    const names = indexes.map(row => row.n.toLowerCase());
    assert.ok(names.includes("ms_characters_user")); assert.ok(names.includes("ms_characters_user_active"));
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
    const row = await sql.single("SELECT deleted_at FROM ms_characters WHERE id=?", [characterId]);
    assert.ok(row.deleted_at instanceof Date);
  });
  test("characters map lastPlayedAt as an ISO string or null", async t => {
    const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
    const never = await f.lobby.create(1, ana); f.advance(1000);
    const played = await f.lobby.create(1, { ...ana, firstName: "Rita" });
    await f.repository.touch(played.characterId, "1");
    assert.equal((await f.repository.get(never.characterId)).lastPlayedAt, null);
    const { lastPlayedAt } = await f.repository.get(played.characterId);
    assert.equal(typeof lastPlayedAt, "string"); assert.equal(new Date(lastPlayedAt).toISOString(), lastPlayedAt);
  });

  // repository.delete (STORY-02.02): owner-only soft delete with an audit row in the same transaction.
  const deletedAt = async id => (await sql.single("SELECT deleted_at FROM ms_characters WHERE id=?", [id])).deleted_at;
  const deleteAudit = () => sql.query("SELECT actor,action,user_id,details FROM ms_audit_log WHERE action='character.deleted' ORDER BY id");
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
    // The audit insert fails inside the transaction: the soft delete done just before it must roll back.
    const failing = { dialect: sql.dialect, transaction: fn => sql.transaction(tx => fn({ ...tx,
      query: (text, ...args) => typeof text === "string" && text.includes("ms_audit_log") ? Promise.reject(new Error("audit failed")) : tx.query(text, ...args) })) };
    const repository = new Repository(() => failing);
    await assert.rejects(repository.delete(characterId, "1"), /audit failed/);
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
    const keys = ["MS_MAX_CHARACTERS", "MS_SAVE_INTERVAL_SECONDS"];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const { log, error } = console, prototypeDelete = Repository.prototype.delete;
    const on = {}, client = {}, sessions = new Map([[7, { sessionId: "s7", userId: "1" }]]);
    const notices = [], states = [], kicks = []; let deleteCalls = 0;
    const player = { id: 7, connected: true, isVisible: () => true, isInvulnerable: () => false, getFastTravelEnabled: () => true,
      setVirtualWorld() {}, setVisible() {}, setInvulnerable() {}, setFastTravelEnabled() {}, hold: () => true, release() {},
      emit(name, payload) { (name === "ms-character:notice" ? notices : states).push(JSON.parse(payload)); }, kick(reason) { kicks.push(reason); } };
    const core = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.has(id) }, Players: { async enterGame() {} } };
    Object.assign(process.env, { MS_MAX_CHARACTERS: "1", MS_SAVE_INTERVAL_SECONDS: "300" });
    Object.assign(globalThis, {
      Events: { on: (name, fn) => { on[name] = fn; }, onClient: (name, fn) => { client[name] = fn; }, emit() {} },
      Exports: { get: (resource, name) => resource === "ms-core" && name === "Core" ? core : resource === "ms-sql" && name === "Sql" ? sql : undefined, register: () => true },
      PlayerManager: { getById: id => id === 7 ? player : null, getAll: () => [] },
    });
    console.log = () => {}; console.error = () => {};
    Repository.prototype.delete = function (...args) { deleteCalls += 1; return prototypeDelete.apply(this, args); };
    try {
      await sql.query("INSERT INTO ms_characters(user_id,first_name,last_name,house,state) VALUES(1,'Ana','Silva','Ravenclaw',?)", [EMPTY_STATE]);
      // main.js keeps module-level state and registers its handlers on load: each dialect needs a fresh copy.
      delete require.cache[require.resolve("../server/main")];
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

  // ms-sql reload: the repository resolves the export on every use and fails with a coded error while it is gone.
  test("a reloaded ms-sql export is picked up lazily and a missing one fails with SQL_UNAVAILABLE", async () => {
    let current = await db.another(2);
    const repository = new Repository(() => current);
    assert.deepEqual(await repository.list("1"), []);
    const stopped = current; current = null; await stopped.close();
    await assert.rejects(repository.list("1"), error => error.code === "SQL_UNAVAILABLE" && error.kind === "NOT_READY");
    await assert.rejects(repository.save("1", "1", 0, {}), error => error.code === "SQL_UNAVAILABLE");
    current = await db.another(2);
    assert.deepEqual(await repository.list("1"), []);
    await assert.rejects(stopped.query("SELECT 1"), error => error.kind === "NOT_READY");
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
    const stored = (await f.repository.get(characterId)).state;
    await sql.update("UPDATE ms_characters SET state=? WHERE id=?", [JSON.stringify({ ...stored, look: null }), characterId]);
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
  test("version 0.6.0 matches package.json, api.version and the README", async t => {
    const f = await fixture(t);
    const fs = require("node:fs"), path = require("node:path");
    const pkg = require("../package.json"), readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    assert.equal(f.lobby.api.version, "0.6.0"); assert.equal(pkg.version, "0.6.0"); assert.match(readme, /versão 0.6.0/);
  });

  test("creations are capped per account in 24 h, deleted characters included (M-01)", async t => {
    const f = await fixture(t, {}, { maxCharacters: 1, maxCreationsPerDay: 2 }); await f.join();
    const first = await f.lobby.create(1, ana); f.advance(1000);
    await f.lobby.delete(1, first.characterId); f.advance(1000);
    const second = await f.lobby.create(1, ana); f.advance(1000);
    await f.lobby.delete(1, second.characterId); f.advance(1000);
    await assert.rejects(f.lobby.create(1, ana), { code: "CREATE_COOLDOWN" });
    assert.equal((await f.repository.list("1")).length, 0);
    // Older creations stop counting.
    await sql.update("UPDATE ms_characters SET created_at=?", [new Date(Date.now() - 25 * 3600 * 1000)]);
    f.advance(1000);
    assert.equal((await f.lobby.create(1, ana)).firstName, "Ana");
  });

  test("purgeDeleted removes only characters deleted longer ago than the retention (M-01)", async t => {
    const f = await fixture(t, {}, { maxCharacters: 3 }); await f.join();
    const old = await f.lobby.create(1, ana); f.advance(1000);
    const recent = await f.lobby.create(1, { ...ana, firstName: "Rita" }); f.advance(1000);
    const active = await f.lobby.create(1, { ...ana, firstName: "Eva" }); f.advance(1000);
    await f.lobby.delete(1, old.characterId); f.advance(1000);
    await f.lobby.delete(1, recent.characterId);
    await sql.update("UPDATE ms_characters SET deleted_at=? WHERE id=?", [new Date(Date.now() - 31 * 86400 * 1000), old.characterId]);
    assert.equal(await f.repository.purgeDeleted(30), 1);
    assert.equal(await f.repository.get(old.characterId, { includeDeleted: true }), null);
    assert.ok(await f.repository.get(recent.characterId, { includeDeleted: true }));
    assert.ok(await f.repository.get(active.characterId));
  });

  test("creating a character saves the role of the chosen house in ms_character_roles", async t => {
    const f = await fixture(t, {}, { maxCharacters: 3, maxCreationsPerDay: 9 }); await f.join();
    const roles = id => sql.query("SELECT role FROM ms_character_roles WHERE character_id=? ORDER BY role", [id]);
    const a = await f.lobby.create(1, { ...ana, house: "Slytherin" }); f.advance(1000);
    const b = await f.lobby.create(1, { ...ana, firstName: "Rita", house: "Unaffiliated" });
    assert.deepEqual((await roles(a.characterId)).map(row => row.role), ["slytherin"]);
    assert.deepEqual((await roles(b.characterId)).map(row => row.role), ["unaffiliated"]);
    assert.deepEqual((await f.repository.get(a.characterId)).roles, ["slytherin"]);
    f.advance(1000); await assert.rejects(f.lobby.create(1, { ...ana, house: "Durmstrang" }), { code: "INVALID_HOUSE" });
    assert.equal(Number(await sql.scalar("SELECT count(*) FROM ms_character_roles")), 2, "a refused creation saves no role");
  });
  test("selecting keeps the roles in memory and gives old characters the role of their house", async t => {
    const f = await fixture(t); await f.join();
    const id = String(await sql.insert("INSERT INTO ms_characters(user_id,first_name,last_name,house,state) VALUES(1,'Old','One','Hufflepuff',?)", [EMPTY_STATE]));
    assert.deepEqual(await f.repository.roles(id), [], "created before the roles existed");
    f.advance(1000); await f.lobby.select(1, id);
    assert.deepEqual(f.lobby.api.getSelected(1).roles, ["hufflepuff"]);
    assert.deepEqual(await f.repository.roles(id), ["hufflepuff"]);
    assert.deepEqual(await f.repository.ensureHouseRole(id, "Hufflepuff"), ["hufflepuff"], "idempotent");
    assert.equal(Number(await sql.scalar("SELECT count(*) FROM ms_character_roles")), 1);
  });
  test("purging a deleted character removes its roles", async t => {
    const f = await fixture(t); await f.join();
    const c = await f.lobby.create(1, ana); f.advance(1000); await f.lobby.delete(1, c.characterId);
    await sql.update("UPDATE ms_characters SET deleted_at=? WHERE id=?", [new Date(Date.now() - 31 * 86400 * 1000), c.characterId]);
    assert.equal(await f.repository.purgeDeleted(30), 1);
    assert.equal(Number(await sql.scalar("SELECT count(*) FROM ms_character_roles")), 0);
  });

  test("deleting or selecting a character of another account leaves an audit trace (L-06)", async t => {
    const f = await fixture(t, {}, { maxCharacters: 2 }); await f.join();
    const mine = await f.lobby.create(1, ana);
    const other = { id: await sql.insert("INSERT INTO ms_characters(user_id,first_name,last_name,house,state) VALUES(2,'Zé','Costa','Ravenclaw',?)", [EMPTY_STATE]) };
    assert.ok(other.id, "the fixture has a second account");
    f.advance(1000);
    await assert.rejects(f.lobby.delete(1, String(other.id)), { code: "CHARACTER_NOT_FOUND" }); f.advance(1000);
    await assert.rejects(f.lobby.select(1, String(other.id)), { code: "CHARACTER_NOT_FOUND" });
    const rows = await sql.query("SELECT actor,action,details FROM ms_audit_log WHERE action LIKE 'character.%_denied' ORDER BY id");
    assert.deepEqual(rows.map(row => [row.actor, row.action, row.details.characterId]), [
      ["user:1", "character.delete_denied", String(other.id)], ["user:1", "character.select_denied", String(other.id)]]);
    assert.ok(mine);
  });

  test("sync is ignored when repeated within 500 ms (L-02)", async t => {
    const f = await fixture(t); await f.join();
    const before = f.sent.length;
    f.lobby.sync(1); f.lobby.sync(1); f.lobby.sync(1);
    assert.equal(f.sent.length - before, 1);
    f.advance(500); f.lobby.sync(1);
    assert.equal(f.sent.length - before, 2);
  });

  test("save and touch do not act on a soft-deleted character (L-07)", async t => {
    const f = await fixture(t); await f.join();
    const { characterId } = await f.lobby.create(1, ana); f.advance(1000);
    await f.lobby.delete(1, characterId);
    await f.repository.touch(characterId, "1");
    assert.equal((await f.repository.get(characterId, { includeDeleted: true })).lastPlayedAt, null);
    await assert.rejects(f.repository.save(characterId, "1", 0, { inventory: [], look: null, location: null }), { code: "REVISION_CONFLICT" });
  });
});

// No database needed: configuration, dialect selection, schema dependency check and deadlock replay.
test("configuration has no database settings and still validates its limits", () => {
  const cfg = loadConfig({ MS_MAX_CHARACTERS: "3", MS_DATABASE_URL: "postgresql://ignored", MS_CHARACTER_POOL_SIZE: "99" }, { envFile: null });
  assert.equal(cfg.maxCharacters, 3);
  for (const key of ["databaseUrl", "databaseConfigured", "poolSize", "queryTimeoutMs"]) assert.equal(key in cfg, false);
  assert.throws(() => loadConfig({ MS_MAX_CHARACTERS: "9" }, { envFile: null }), /MS_MAX_CHARACTERS/);
});
test("the DDL never creates or names a schema or database", () => {
  for (const dialect of ["postgres", "mysql"]) {
    const ddl = schemaFor(dialect).join(String.fromCharCode(10));
    assert.doesNotMatch(ddl, /CREATE\s+(SCHEMA|DATABASE)/i);
    assert.doesNotMatch(ddl, /ms_core|ms_character\b|REFERENCES\s+\w+\./i);
    assert.match(ddl, /REFERENCES ms_users\(id\)/);
  }
});
test("the schema is chosen by dialect and MySQL/MariaDB share one DDL", () => {
  assert.equal(schemaFor("postgres"), require("../server/database/schema.postgres"));
  assert.equal(schemaFor("mysql"), schemaFor("mariadb"));
  assert.throws(() => schemaFor("sqlite"), /UNSUPPORTED_SQL_DIALECT/);
  for (const dialect of ["postgres", "mysql"]) assert.ok(schemaFor(dialect).every(statement => typeof statement === "string" && !statement.trim().endsWith(";")));
  assert.ok(schemaFor("mysql").every(statement => !/\bDEFAULT\s+'\{/.test(statement)), "no literal JSON default on MySQL");
});
test("createTables refuses to run without ms-core's schema and never creates ms-character's", async () => {
  const statements = [];
  const sql = { dialect: "postgres", withLock: (name, fn) => fn({ single: async () => null, query: async text => { statements.push(text); } }) };
  await assert.rejects(new Repository(sql).createTables(), { code: "MS_CORE_SCHEMA_MISSING" });
  assert.deepEqual(statements, []);
});
test("a deadlock victim is replayed twice at most, other errors pass through", async () => {
  let calls = 0;
  const flaky = failures => ({ transaction: async fn => { calls++; if (calls <= failures) throw Object.assign(new Error("deadlock"), { kind: "DEADLOCK" }); return fn({}); } });
  assert.equal(await new Repository(flaky(2)).transaction(async () => "done"), "done"); assert.equal(calls, 3);
  calls = 0; await assert.rejects(new Repository(flaky(3)).transaction(async () => "done"), { kind: "DEADLOCK" }); assert.equal(calls, 3);
  const broken = { transaction: async () => { throw Object.assign(new Error("x"), { kind: "CONNECTION" }); } };
  await assert.rejects(new Repository(broken).transaction(async () => {}), { kind: "CONNECTION" });
});
test("game.apply does not call setLook when state.look is null", async () => {
  const { createGameAdapter } = require("../server/game");
  const game = createGameAdapter(loadConfig({})); let looks = 0;
  const player = { id: 1, connected: true, inventory: { replace(rows, done) { done(null, { revision: 1 }); }, waitForRevision: () => Promise.resolve({}) },
    location: () => ({ areaId: "Overland", x: 1, y: 2, z: 3 }), release() {}, setLook() { looks++; }, setSpawn() {},
    teleport() { return 5; } };
  const restoring = game.apply(player, { house: "Ravenclaw", state: { inventory: [], look: null, location: null } }, () => true, 1);
  await new Promise(resolve => setImmediate(resolve)); game.complete(1, "teleport", 5, 0); await restoring;
  assert.equal(looks, 0);
});
