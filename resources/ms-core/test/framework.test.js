"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
const { Repository } = require("../server/database/repository");
const { createCore } = require("../server/core");
const { loadConfig } = require("../server/config");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
let engine, server, bootstrap, config;
const connection = (id, extra = {}) => ({ nickname: "Player " + id, discordId: "discord-" + id, hardwareId: "machine-" + id, ip: "127.0.0.1", ...extra });

before(async () => {
  engine = await PGlite.create();
  server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 8 });
  await server.start();
  config = { ...loadConfig({}), databaseUrl: "postgresql://postgres:postgres@" + server.getServerConn() + "/postgres", databaseConfigured: true, poolSize: 1 };
  bootstrap = new Repository(config); await bootstrap.createSchema();
});
after(async () => { await bootstrap?.close(); await server?.stop(); await engine?.close(); });
beforeEach(async () => { await bootstrap.pool.query("TRUNCATE ms_core.ms_users RESTART IDENTITY CASCADE"); });

async function fixture(t, overrides = {}) {
  let now = 1000000;
  const repository = new Repository(config), sent = [], kicks = [], events = [], released = [];
  const game = { restrict() {}, release(p) { released.push(p.id); }, cancel() {},
    send(p, name, payload) { sent.push({ playerId: p.id, name, payload }); },
    kick(p, reason) { kicks.push({ playerId: p.id, reason }); }, ...overrides };
  const core = createCore({ repository, config, game, clock: () => now, emit: (name, payload) => events.push({ name, payload }), logger: { error() {} } });
  t.after(async () => { await core.stop(); await repository.close(); });
  const player = id => ({ id, connected: true, nickname: "Player " + id, discordId: "discord-" + id, hardwareId: "machine-" + id });
  async function register(id = 1, credential = null, confirm = true, loaded = true) {
    await core.attach(player(id), loaded);
    const s = core.api.Users.get(id);
    await core.register(id, { sessionId: s.sessionId, credential });
    const issued = sent.filter(v => v.playerId === id && v.name === "ms-core:credential").at(-1)?.payload.credential;
    if (!credential && confirm) await core.credentialStored(id, { sessionId: s.sessionId });
    return { userId: core.api.Users.get(id)?.userId, credential: credential || issued, sessionId: s.sessionId };
  }
  async function ready(id = 1) {
    const account = await register(id);
    await repository.setAllowlist(account.userId, "approved", "console:test"); await core.tick();
    return account;
  }
  return { core, repository, sent, kicks, events, released, player, register, ready, advance(ms) { now += ms; } };
}

test("PostgreSQL creates sequential numeric account IDs pending by default", async t => {
  const f = await fixture(t), first = await f.register(1), second = await f.register(2);
  assert.equal(first.userId, "1"); assert.equal(second.userId, "2");
  assert.equal((await f.repository.getUser("1")).allowlist, "pending");
  assert.equal(f.core.api.Users.get(1).status, "awaitingApproval");
  assert.equal(f.core.api.Users.isReady(1), false);
});
test("the database keeps only a hash of the automatically issued key", async t => {
  const f = await fixture(t), account = await f.register();
  const rows = (await f.repository.pool.query("SELECT * FROM ms_core.ms_user_credentials")).rows;
  assert.equal(rows[0].token_hash, digest(account.credential));
  assert.ok(!JSON.stringify(rows).includes(account.credential));
  assert.ok(!JSON.stringify(f.core.api.Users.get(1)).includes(account.credential));
});

test("sessions, bans and audit use database-generated numeric IDs and valid references", async t => {
  const f = await fixture(t), first = await f.register(1), second = await f.register(2);
  assert.equal(first.sessionId, "1"); assert.equal(second.sessionId, "2");
  const banId = await f.repository.ban(first.userId, "test ban", null, "console:test");
  assert.equal(banId, "1"); assert.equal((await f.repository.activeBan(first.userId)).id, banId);
  const audit = (await f.repository.pool.query("SELECT id,details FROM ms_core.ms_audit_log ORDER BY id")).rows;
  assert.deepEqual(audit.map(row => row.id), ["1", "2", "3"]);
  assert.equal(audit[2].details.banId, banId);
  const ids = (await f.repository.pool.query("SELECT DISTINCT user_id FROM ms_core.ms_connection_identifiers ORDER BY user_id")).rows;
  assert.deepEqual(ids.map(row => row.user_id), [first.userId, second.userId]);
  await f.core.disconnect(1);
  assert.ok((await f.repository.pool.query("SELECT ended_at FROM ms_core.ms_sessions WHERE id=$1", [first.sessionId])).rows[0].ended_at);
});

test("numeric session, ban and audit IDs preserve BIGINT precision", async t => {
  const f = await fixture(t);
  for (const table of ["ms_sessions", "ms_bans", "ms_audit_log"]) {
    await f.repository.pool.query(`ALTER TABLE ms_core.${table} ALTER COLUMN id RESTART WITH 9007199254740993`);
  }
  const account = await f.register();
  assert.equal(account.sessionId, "9007199254740993");
  assert.equal(await f.repository.ban(account.userId, "test", null, "console:test"), "9007199254740993");
  const audit = (await f.repository.pool.query("SELECT id FROM ms_core.ms_audit_log ORDER BY id")).rows;
  assert.deepEqual(audit.map(row => row.id), ["9007199254740993", "9007199254740994"]);
});

test("disconnect during session INSERT closes its history after the numeric ID arrives", async t => {
  const f = await fixture(t), start = f.repository.startSession.bind(f.repository);
  let resume;
  f.repository.startSession = (...args) => new Promise((resolve, reject) => { resume = () => start(...args).then(resolve, reject); });
  const attaching = f.core.attach(f.player(1));
  const rejected = assert.rejects(attaching, { code: "SESSION_EXPIRED" });
  assert.equal(f.core.api.Users.get(1).sessionId, null);
  const guard = f.core.guard(1); assert.equal(guard(), true);
  const disconnecting = f.core.disconnect(1);
  assert.equal(guard(), false);
  await resume(); await Promise.all([rejected, disconnecting]);
  const row = (await f.repository.pool.query("SELECT id,ended_at,end_reason FROM ms_core.ms_sessions")).rows[0];
  assert.equal(row.id, "1"); assert.ok(row.ended_at); assert.equal(row.end_reason, "disconnect");
  assert.equal(f.events.find(e => e.name === "ms:sessionEnded").payload.sessionId, row.id);
});

test("a pending session guard cannot match a replacement with no allocated ID", async t => {
  const f = await fixture(t), start = f.repository.startSession.bind(f.repository), resumes = [];
  f.repository.startSession = (...args) => new Promise((resolve, reject) => resumes.push(() => start(...args).then(resolve, reject)));
  const first = f.core.attach(f.player(1));
  const rejected = assert.rejects(first, { code: "SESSION_EXPIRED" });
  const guard = f.core.guard(1), disconnecting = f.core.disconnect(1);
  const second = f.core.attach(f.player(1));
  assert.equal(f.core.api.Users.get(1).sessionId, null); assert.equal(guard(), false);
  const current = f.core.guard(1); assert.equal(current(), true);
  await resumes[0](); await Promise.all([rejected, disconnecting]);
  await resumes[1](); const result = await second;
  assert.equal(result.sessionId, "2"); assert.equal(current(), true); assert.equal(guard(), false);
});
test("the public numeric ID alone cannot identify an existing account", async t => {
  const f = await fixture(t); await f.register(); await f.core.attach(f.player(2));
  assert.throws(() => f.core.register(2, { sessionId: f.core.api.Users.get(2).sessionId, credential: "1" }), { code: "INVALID_CREDENTIAL" });
});
test("an existing identifier blocks a second account without granting access to the first", async t => {
  const f = await fixture(t); const original = await f.register(1);
  await f.core.attach({ ...f.player(2), discordId: "discord-1" });
  await assert.rejects(f.core.register(2, { sessionId: f.core.api.Users.get(2).sessionId, credential: null }), { code: "IDENTIFIER_ALREADY_REGISTERED" });
  assert.equal((await f.repository.listUsers()).length, 1);
  assert.equal(f.core.api.Users.get(2), null);
  assert.equal(f.core.api.Users.get(1).userId, original.userId);
  assert.match(f.kicks.at(-1).reason, /associados a uma conta/);
});
test("returning with the local key retrieves the same numeric ID", async t => {
  const f = await fixture(t), account = await f.register(); await f.core.disconnect(1);
  const next = await f.register(2, account.credential);
  assert.equal(next.userId, account.userId); assert.equal((await f.repository.listUsers()).length, 1);
});

test("each account identifier is globally exclusive and failed registration leaves no partial account", async t => {
  const f = await fixture(t);
  for (const kind of ["steamId", "epicId", "discordId", "hardwareId"]) {
    const value = "existing-" + kind;
    const account = await f.repository.register(null, digest("first-" + kind), { [kind]: value });
    await assert.rejects(f.repository.register(null, digest("second-" + kind), { [kind]: value }), { code: "IDENTIFIER_ALREADY_REGISTERED" });
    assert.equal((await f.repository.pool.query("SELECT user_id FROM ms_core.ms_connection_identifiers WHERE kind=$1 AND value=$2", [kind, value])).rows[0].user_id, account.userId);
  }
  for (const table of ["ms_users", "ms_user_credentials", "ms_user_roles", "ms_audit_log"]) {
    assert.equal((await f.repository.pool.query(`SELECT count(*) AS n FROM ms_core.${table}`)).rows[0].n, "4");
  }
});

test("accounts can share IP addresses and display names", async t => {
  const f = await fixture(t);
  for (const id of [1, 2]) {
    await f.core.attach({ ...f.player(id), ip: "127.0.0.1", nickname: "Same Name", discordName: "same-name" });
    await f.core.register(id, { sessionId: f.core.api.Users.get(id).sessionId, credential: null });
  }
  assert.equal((await f.repository.listUsers()).length, 2);
  assert.equal((await f.repository.pool.query("SELECT count(*) AS n FROM ms_core.ms_connection_identifiers WHERE kind='ip'")).rows[0].n, "2");
});

test("new accounts require at least one non-empty account identifier", async t => {
  const f = await fixture(t);
  for (const identifiers of [{}, { ip: "127.0.0.1", nickname: "Name" }, { hardwareId: "  " }]) {
    await assert.rejects(f.repository.register(null, digest("empty"), identifiers), { code: "IDENTIFIER_REQUIRED" });
  }
  assert.equal((await f.repository.listUsers()).length, 0);
});

test("reconnecting updates account identifiers without duplicating them or releasing old IDs", async t => {
  const f = await fixture(t), first = await f.register(1);
  await f.core.disconnect(1);
  await f.repository.pool.query("UPDATE ms_core.ms_connection_identifiers SET last_seen_at='2020-01-01' WHERE user_id=$1", [first.userId]);
  await f.register(1, first.credential); await f.core.disconnect(1);
  const rows = (await f.repository.pool.query("SELECT * FROM ms_core.ms_connection_identifiers WHERE user_id=$1", [first.userId])).rows;
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.last_seen_at.getUTCFullYear() > 2020));
  await f.register(2, first.credential); await f.core.disconnect(2);
  await assert.rejects(f.register(1), { code: "IDENTIFIER_ALREADY_REGISTERED" });
  assert.equal((await f.repository.listUsers()).length, 1);
});

test("a returning credential cannot claim identifiers owned by another account", async t => {
  const f = await fixture(t), first = await f.register(1); await f.register(2); await f.core.disconnect(1);
  await f.core.attach({ ...f.player(3), hardwareId: "machine-2" });
  await assert.rejects(f.core.register(3, { sessionId: f.core.api.Users.get(3).sessionId, credential: first.credential }), { code: "IDENTIFIER_ALREADY_REGISTERED" });
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_connection_identifiers WHERE value='discord-3'")).rowCount, 0);
  assert.equal((await f.repository.pool.query("SELECT user_id FROM ms_core.ms_connection_identifiers WHERE value='machine-2'")).rows[0].user_id, "2");
});

test("the database rejects duplicate identifier ownership even outside the registration code", async t => {
  const f = await fixture(t), first = await f.register(1), second = await f.register(2);
  await assert.rejects(f.repository.pool.query("INSERT INTO ms_core.ms_connection_identifiers(user_id,kind,value) VALUES($1,'discordId','discord-1')", [second.userId]), { code: "23505", constraint: "ms_connection_identifiers_unique_owner" });
  assert.equal((await f.repository.pool.query("SELECT user_id FROM ms_core.ms_connection_identifiers WHERE kind='discordId' AND value='discord-1'")).rows[0].user_id, first.userId);
});

test("simultaneous registrations through independent pools create only one owner", async t => {
  const f = await fixture(t), other = new Repository(config); t.after(() => other.close());
  const results = await Promise.allSettled([
    f.repository.register(null, digest("concurrent-a"), { hardwareId: "same-device" }),
    other.register(null, digest("concurrent-b"), { hardwareId: "same-device" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "IDENTIFIER_ALREADY_REGISTERED");
  assert.equal((await f.repository.listUsers()).length, 1);
  assert.equal((await f.repository.pool.query("SELECT count(*) AS n FROM ms_core.ms_user_credentials")).rows[0].n, "1");
});
test("a key unknown to the database (e.g. after a reset) is replaced by a newly issued one", async t => {
  const f = await fixture(t); await f.core.attach(f.player(1));
  const { sessionId } = f.core.api.Users.get(1), stale = "a".repeat(43);
  await f.core.register(1, { sessionId, credential: stale });
  const issued = f.sent.filter(v => v.name === "ms-core:credential").at(-1)?.payload.credential;
  assert.match(issued, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(issued, stale);
  assert.equal(f.kicks.length, 0); assert.equal(f.core.api.Users.get(1).status, "awaitingCredentialStorage");
  await f.core.credentialStored(1, { sessionId });
  assert.equal(f.core.api.Users.get(1).status, "awaitingApproval");
  assert.deepEqual((await f.repository.listUsers()).map(u => u.userId), ["1"]);
  await f.core.disconnect(1); assert.equal((await f.register(2, issued)).userId, "1");
});
test("an unknown key cannot create a duplicate of an account that owns the same identifiers", async t => {
  const f = await fixture(t); await f.register(1); await f.core.disconnect(1);
  await f.core.attach(f.player(1));
  await assert.rejects(f.core.register(1, { sessionId: f.core.api.Users.get(1).sessionId, credential: "a".repeat(43) }), { code: "IDENTIFIER_ALREADY_REGISTERED" });
  assert.equal((await f.repository.listUsers()).length, 1); assert.equal(f.kicks.length, 1);
});
test("new credentials must be acknowledged before allowlist can release a session", async t => {
  const f = await fixture(t), account = await f.register(1, null, false);
  await f.repository.setAllowlist(account.userId, "approved", "console:test"); await f.core.tick();
  assert.equal(f.core.api.Users.get(1).status, "awaitingCredentialStorage");
  await f.core.credentialStored(1, { sessionId: account.sessionId });
  assert.equal(f.core.api.Users.get(1).status, "ready");
});
test("repeated credential acknowledgements are harmless", async t => {
  const f = await fixture(t), account = await f.register();
  await f.core.credentialStored(1, { sessionId: account.sessionId });
  assert.equal(f.core.api.Users.get(1).status, "awaitingApproval");
});
test("approval from another application is detected without reconnecting", async t => {
  const f = await fixture(t), account = await f.register();
  await bootstrap.pool.query("UPDATE ms_core.ms_users SET allowlist='approved' WHERE id=$1", [account.userId]);
  await f.core.tick(); assert.equal(f.core.api.Users.isReady(1), true);
  assert.deepEqual(f.released, [1]);
  const ready = f.events.filter(e => e.name === "ms:playerReady");
  assert.deepEqual(ready.map(e => e.payload), [{ playerId: 1, sessionId: account.sessionId, userId: account.userId }]);
  await f.core.tick(); assert.equal(f.events.filter(e => e.name === "ms:playerReady").length, 1);
});
test("an approved account waits for the world to load before leaving quarantine", async t => {
  const f = await fixture(t), account = await f.register(1, null, true, false);
  await f.repository.setAllowlist(account.userId, "approved", "console:test"); await f.core.tick();
  assert.equal(f.core.api.Users.get(1).status, "waitingForWorld");
  assert.equal(f.events.some(e => e.name === "ms:playerReady"), false); assert.deepEqual(f.released, []);
  assert.equal(f.events.filter(e => e.name === "ms:userAuthenticated").length, 1);
  await f.core.loaded(1);
  assert.equal(f.core.api.Users.isReady(1), true); assert.deepEqual(f.released, [1]);
  assert.equal(f.events.filter(e => e.name === "ms:playerReady").length, 1);
});
test("an account approved before connecting becomes ready right after the key check", async t => {
  const f = await fixture(t), { userId } = await f.core.admit(connection(1));
  await f.repository.setAllowlist(userId, "approved", "console:test");
  await f.register(1);
  assert.equal(f.core.api.Users.isReady(1), true);
  assert.equal(f.sent.filter(v => v.name === "ms-core:session").at(-1).payload.status, "ready");
  assert.equal("Characters" in f.core.api, false);
});
test("duplicate registration messages are coalesced into one account", async t => {
  const f = await fixture(t); await f.core.attach(f.player(1));
  const input = { sessionId: f.core.api.Users.get(1).sessionId, credential: null };
  await Promise.all([f.core.register(1, input), f.core.register(1, input)]);
  assert.equal((await f.repository.listUsers()).length, 1);
});
test("the same key cannot open two simultaneous sessions", async t => {
  const f = await fixture(t), account = await f.register();
  await f.core.attach(f.player(2));
  await assert.rejects(f.core.register(2, { sessionId: f.core.api.Users.get(2).sessionId, credential: account.credential }), { code: "ACCOUNT_ALREADY_ONLINE" });
});
test("an old session request cannot register a reused native player ID", async t => {
  const f = await fixture(t); await f.core.attach(f.player(1));
  const old = f.core.api.Users.get(1).sessionId; await f.core.disconnect(1); await f.core.attach(f.player(1));
  assert.throws(() => f.core.register(1, { sessionId: old, credential: null }), { code: "SESSION_EXPIRED" });
});
test("a delayed database registration cannot bind a replacement session", async t => {
  const f = await fixture(t); await f.core.attach(f.player(1));
  const create = f.repository.register.bind(f.repository); let resume;
  f.repository.register = (...args) => new Promise(resolve => { resume = async () => resolve(await create(...args)); });
  const request = f.core.register(1, { sessionId: f.core.api.Users.get(1).sessionId, credential: null });
  await f.core.disconnect(1); await f.core.attach(f.player(1)); await resume();
  await assert.rejects(request, { code: "SESSION_EXPIRED" });
  assert.equal(f.core.api.Users.get(1).userId, null);
});
test("pending accounts cannot use administrative permissions", async t => {
  const f = await fixture(t); await f.register();
  assert.equal(f.core.api.Users.isReady(1), false);
  assert.equal(await f.core.api.Users.hasPermission(1, "allowlist.manage"), false);
});
test("readers cannot mutate the roles stored in memory", async t => {
  const f = await fixture(t); await f.ready();
  const value = f.core.api.Users.get(1); value.roles.push("admin");
  assert.equal(await f.core.api.Users.hasPermission(1, "roles.manage"), false);
});
test("roles are checked against PostgreSQL and revocation is immediate", async t => {
  const f = await fixture(t), account = await f.ready();
  await f.repository.setRole(account.userId, "admin", true, "console:test");
  assert.equal(await f.core.api.Users.hasPermission(1, "roles.manage"), true);
  await f.repository.setRole(account.userId, "admin", false, "console:test");
  assert.equal(await f.core.api.Users.hasPermission(1, "roles.manage"), false);
});
test("allowlist revocation and bans remove online access", async t => {
  const f = await fixture(t), account = await f.ready();
  await f.repository.setAllowlist(account.userId, "denied", "console:test"); await f.core.tick();
  assert.equal(f.core.api.Users.get(1), null);
});
test("metadata validates ownership and protects permission fields", async t => {
  const f = await fixture(t), account = await f.ready();
  await f.core.api.Users.setMetadata(account.userId, "preferences", { language: "pt" }, 1);
  assert.equal((await f.repository.getUser(account.userId)).metadata.preferences.language, "pt");
  await assert.rejects(f.core.api.Users.setMetadata(account.userId, "roles", ["admin"], 1), { code: "INVALID_METADATA_KEY" });
  await assert.rejects(f.core.api.Users.setMetadata("999", "preferences", {}, 1), { code: "FORBIDDEN" });
});
test("public IDs are BIGINT decimal strings, not lossy JS numbers", async t => {
  const f = await fixture(t);
  await f.repository.pool.query("ALTER TABLE ms_core.ms_users ALTER COLUMN id RESTART WITH 9007199254740993");
  const account = await f.register(); assert.equal(account.userId, "9007199254740993");
});
test("recovery reassigns only a pending device and revokes previous keys", async t => {
  const f = await fixture(t), original = await f.ready(1), pending = await f.register(2);
  await f.repository.recoverCredential(pending.userId, original.userId, "console:test");
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_connection_identifiers WHERE user_id=$1", [pending.userId])).rowCount, 0);
  assert.equal((await f.repository.pool.query("SELECT user_id FROM ms_core.ms_connection_identifiers WHERE value='machine-2'")).rows[0].user_id, original.userId);
  await f.core.tick(); assert.equal(f.core.api.Users.get(1), null); assert.equal(f.core.api.Users.get(2), null);
  const restored = await f.register(3, pending.credential); assert.equal(restored.userId, original.userId);
  await f.core.attach(f.player(4));
  await assert.rejects(f.core.register(4, { sessionId: f.core.api.Users.get(4).sessionId, credential: original.credential }), { code: "INVALID_CREDENTIAL" });
});
test("pending sessions expire but their local key still retrieves the account", async t => {
  const f = await fixture(t), account = await f.register(); f.advance(config.approvalTimeoutMs + 1); await f.core.tick();
  assert.equal(f.core.api.Users.get(1), null);
  assert.equal((await f.register(2, account.credential)).userId, account.userId);
});
test("database configuration has no SQLite or OAuth fallback", () => {
  assert.equal(loadConfig({}).databaseConfigured, false);
  assert.throws(() => loadConfig({ MS_DATABASE_URL: "sqlite:example" }));
  assert.throws(() => loadConfig({ MS_ALLOWLIST_FORM_URL: "javascript:alert(1)" }));
});

// Loading-screen admission (playerConnecting): numeric ID before entering the world.
test("the loading screen registers a pending account and returns its numeric ID without admitting it", async t => {
  const f = await fixture(t), first = await f.core.admit(connection(1));
  assert.deepEqual([first.allowed, first.userId, first.allowlist, first.created], [false, "1", "pending", true]);
  assert.match(first.message, /ID: 1 criado\. Aguarda aprovação/);
  const again = await f.core.admit(connection(1));
  assert.deepEqual([again.allowed, again.userId, again.created], [false, "1", false]);
  assert.equal((await f.repository.listUsers()).length, 1);
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_user_credentials")).rowCount, 0);
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_sessions")).rowCount, 0);
});
test("the loading screen includes the form URL with the numeric ID", async t => {
  const repository = new Repository(config), core = createCore({ repository, config: { ...config, formUrl: "https://forms.example/allowlist" }, game: {}, logger: { error() {} } });
  t.after(async () => { await core.stop(); await repository.close(); });
  assert.match((await core.admit(connection(1))).message, /https:\/\/forms\.example\/allowlist\?id=1/);
});
test("only approved accounts enter, and the game client then claims a key for the same ID", async t => {
  const f = await fixture(t), { userId } = await f.core.admit(connection(1));
  await f.repository.setAllowlist(userId, "approved", "console:test");
  const admitted = await f.core.admit(connection(1));
  assert.equal(admitted.allowed, true); assert.match(admitted.message, /ID: 1 aprovado/);
  const account = await f.register(1);
  assert.equal(account.userId, userId); assert.ok(account.credential);
  assert.equal(f.core.api.Users.get(1).status, "ready");
  assert.equal((await f.repository.listUsers()).length, 1);
  await f.core.attach({ ...f.player(3), discordId: "discord-1" });
  await assert.rejects(f.core.register(3, { sessionId: f.core.api.Users.get(3).sessionId, credential: null }), { code: "IDENTIFIER_ALREADY_REGISTERED" });
});
test("identifiers alone never hand over an account that already holds a key", async t => {
  const f = await fixture(t), original = await f.ready(1); await f.core.disconnect(1);
  assert.equal((await f.core.admit(connection(1))).allowed, true);
  await f.core.attach({ ...f.player(2), discordId: "discord-1", hardwareId: "machine-1" });
  await assert.rejects(f.core.register(2, { sessionId: f.core.api.Users.get(2).sessionId, credential: null }), { code: "IDENTIFIER_ALREADY_REGISTERED" });
  assert.equal((await f.register(3, original.credential)).userId, original.userId);
});
test("reset-key lets the next client with the account identifiers claim a new key", async t => {
  const f = await fixture(t), original = await f.ready(1); await f.core.disconnect(1);
  await f.repository.revokeCredentials(original.userId, "console:test");
  const claimed = await f.register(1);
  assert.equal(claimed.userId, original.userId); assert.notEqual(claimed.credential, original.credential);
  await f.core.attach(f.player(2));
  await assert.rejects(f.core.register(2, { sessionId: f.core.api.Users.get(2).sessionId, credential: original.credential }), { code: "INVALID_CREDENTIAL" });
});
test("the loading screen rejects denied, banned and already-online accounts with their ID", async t => {
  const f = await fixture(t), online = await f.ready(1);
  assert.match((await f.core.admit(connection(1))).message, /ID: 1: esta conta já está ligada/);
  const { userId } = await f.core.admit(connection(2));
  await f.repository.setAllowlist(userId, "denied", "console:test");
  const denied = await f.core.admit(connection(2));
  assert.equal(denied.allowed, false); assert.match(denied.message, /ID: 2: o pedido de allowlist foi recusado/);
  await f.core.disconnect(1); await f.repository.ban(online.userId, "Teste", null, "console:test");
  const banned = await f.core.admit(connection(1));
  assert.equal(banned.allowed, false); assert.match(banned.message, /ID: 1 bloqueado: Teste/);
});
test("the loading screen requires an account identifier and refuses ambiguous owners", async t => {
  const f = await fixture(t);
  await assert.rejects(f.core.admit({ nickname: "x", ip: "127.0.0.1" }), { code: "IDENTIFIER_REQUIRED" });
  await f.core.admit(connection(1)); await f.core.admit(connection(2));
  await assert.rejects(f.core.admit(connection(3, { discordId: "discord-1", hardwareId: "machine-2" })), { code: "IDENTIFIER_CONFLICT" });
  assert.equal((await f.repository.listUsers()).length, 2);
});
test("simultaneous handshakes with the same identifiers create a single account", async t => {
  const f = await fixture(t), other = new Repository({ ...config, poolSize: 2 });
  t.after(() => other.close());
  const results = await Promise.all([f.repository.admission(connection(1)), other.admission(connection(1)), other.admission(connection(1))]);
  assert.deepEqual([...new Set(results.map(r => r.userId))], ["1"]);
  assert.equal((await f.repository.listUsers()).length, 1);
});
test("recovery accepts a loading-screen account that never received a key", async t => {
  const f = await fixture(t), original = await f.ready(1); await f.core.disconnect(1);
  const { userId } = await f.core.admit(connection(2));
  await f.repository.recoverCredential(userId, original.userId, "console:test");
  const claimed = await f.register(2);
  assert.equal(claimed.userId, original.userId);
});
test("required identifiers are explained on the loading screen before any account is created", async t => {
  const repository = new Repository(config), kicks = [];
  const game = { restrict() {}, release() {}, cancel() {}, send() {}, kick(p, reason) { kicks.push(reason); } };
  const core = createCore({ repository, config: { ...config, requiredIdentifiers: [["discordId"], ["steamId"]] }, game, logger: { error() {} } });
  t.after(async () => { await core.stop(); await repository.close(); });
  const missing = await core.admit(connection(1, { steamId: "steam-1", discordId: "" }));
  assert.equal(missing.allowed, false); assert.equal(missing.userId, null);
  assert.match(missing.message, /exige: Discord: abre a aplicação do Discord/); assert.doesNotMatch(missing.message, /Steam/);
  assert.match((await core.admit(connection(1, { discordId: "" }))).message, /Discord.*Steam/);
  assert.equal((await repository.listUsers()).length, 0);
  assert.equal((await core.admit(connection(1, { steamId: "steam-1" }))).userId, "1");
  // Players attached without a handshake (resource restart) are checked at in-game registration.
  await core.attach({ id: 2, connected: true, discordId: "discord-2" });
  await assert.rejects(core.register(2, { sessionId: core.api.Users.get(2).sessionId, credential: null }), { code: "IDENTIFIER_MISSING" });
  assert.match(kicks.at(-1), /Steam: inicia o jogo pela Steam/); assert.equal(core.api.Users.get(2), null);
  assert.equal((await repository.listUsers()).length, 1);
});
test("required identifier groups accept any platform inside an OR group", async t => {
  const repository = new Repository(config);
  const core = createCore({ repository, config: { ...config, requiredIdentifiers: [["discordId"], ["steamId", "epicId"]] }, game: {}, logger: { error() {} } });
  t.after(async () => { await core.stop(); await repository.close(); });
  const none = await core.admit(connection(1));
  assert.equal(none.allowed, false);
  assert.match(none.message, /exige: Steam ou Epic Games: inicia o jogo pela Steam.*; ou inicia o jogo pela Epic/); assert.doesNotMatch(none.message, /Discord/);
  assert.equal((await core.admit(connection(1, { epicId: "epic-1" }))).userId, "1");
  assert.equal((await core.admit(connection(2, { steamId: "steam-2" }))).userId, "2");
  assert.match((await core.admit(connection(3, { steamId: "steam-3", discordId: "" }))).message, /exige: Discord: abre/);
});
test("the loading screen binds newly announced identifiers to the matched account", async t => {
  const f = await fixture(t), { userId } = await f.core.admit(connection(1));
  const again = await f.core.admit(connection(1, { steamId: "steam-1", nickname: "Novo nome" }));
  assert.equal(again.userId, userId); assert.equal(again.created, false);
  const rows = (await f.repository.pool.query("SELECT kind,value FROM ms_core.ms_connection_identifiers WHERE user_id=$1 ORDER BY kind,value", [userId])).rows;
  assert.ok(rows.some(r => r.kind === "steamId" && r.value === "steam-1"));
  assert.deepEqual(rows.filter(r => r.kind === "nickname").map(r => r.value), ["Novo nome"]);
  assert.equal(rows.filter(r => r.kind === "discordId").length, 1);
  const audit = (await f.repository.pool.query("SELECT details FROM ms_core.ms_audit_log WHERE action='identifiers.added'")).rows;
  assert.deepEqual(audit.map(r => r.details.kinds), [["steamId"]]);
  await f.core.admit(connection(1, { steamId: "steam-1", nickname: "Novo nome" }));
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_audit_log WHERE action='identifiers.added'")).rowCount, 1);
  // The new Steam ID now identifies the same account on its own.
  assert.equal((await f.core.admit({ steamId: "steam-1" })).userId, userId);
  await f.core.admit(connection(2));
  await assert.rejects(f.core.admit(connection(2, { steamId: "steam-1" })), { code: "IDENTIFIER_CONFLICT" });
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_connection_identifiers WHERE value='steam-1'")).rowCount, 1);
});
test("an account identifier that already exists never gains a second value", async t => {
  const f = await fixture(t), { userId } = await f.core.admit(connection(1));
  const result = await f.core.admit(connection(1, { discordId: "discord-novo", steamId: "steam-1" }));
  assert.equal(result.userId, userId);
  const rows = (await f.repository.pool.query("SELECT kind,value FROM ms_core.ms_connection_identifiers WHERE user_id=$1 ORDER BY kind,value", [userId])).rows;
  assert.deepEqual(rows.filter(r => r.kind === "discordId").map(r => r.value), ["discord-1"]);
  assert.deepEqual(rows.filter(r => r.kind === "steamId").map(r => r.value), ["steam-1"]);
  const audit = (await f.repository.pool.query("SELECT details FROM ms_core.ms_audit_log WHERE action='identifiers.added'")).rows;
  assert.deepEqual(audit.at(-1).details, { kinds: ["steamId"], ignored: ["discordId"] });
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_connection_identifiers WHERE value='discord-novo'")).rowCount, 0);
  // The in-game key path follows the same rule.
  const account = await f.register(1);
  await f.core.disconnect(1);
  await f.register(2, account.credential);
  assert.deepEqual((await f.repository.pool.query("SELECT value FROM ms_core.ms_connection_identifiers WHERE user_id=$1 AND kind IN ('discordId','hardwareId') ORDER BY value", [userId])).rows.map(r => r.value), ["discord-1", "machine-1"]);
});
test("IP, nickname and Discord name keep one row per kind updated to the latest value", async t => {
  const f = await fixture(t), { userId } = await f.core.admit(connection(1, { discordName: "ana" }));
  const kinds = async () => (await f.repository.pool.query("SELECT kind,value FROM ms_core.ms_connection_identifiers WHERE user_id=$1 AND kind IN ('ip','nickname','discordName') ORDER BY kind", [userId])).rows;
  // Legacy history rows converge to a single row.
  await f.repository.pool.query("INSERT INTO ms_core.ms_connection_identifiers(user_id,kind,value,last_seen_at) VALUES($1,'ip','10.0.0.9','2020-01-01')", [userId]);
  await f.core.admit(connection(1, { ip: "10.0.0.2", nickname: "Ana Silva", discordName: "ana" }));
  assert.deepEqual(await kinds(), [{ kind: "discordName", value: "ana" }, { kind: "ip", value: "10.0.0.2" }, { kind: "nickname", value: "Ana Silva" }]);
  const account = await f.register(1); await f.core.disconnect(1);
  await f.register(2, account.credential);
  assert.deepEqual((await kinds()).map(r => r.value), ["ana", "10.0.0.2", "Player 2"]);
  assert.equal((await f.repository.pool.query("SELECT 1 FROM ms_core.ms_audit_log WHERE action='identifiers.added'")).rowCount, 0);
});
