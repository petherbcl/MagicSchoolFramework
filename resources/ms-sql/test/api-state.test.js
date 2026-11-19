"use strict";
// createSql state machine against a scriptable fake driver: readiness, reconnection, transactions, locks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSql } = require("../server");
const { loadConfig } = require("../server/config");
const { fakeDriver, labels } = require("./helpers/fake-driver");

const config = (extra = {}) => loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db", ...extra }, { envFile: null });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, ms = 2000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error("condition not met"); await wait(5); } };
const rejects = (promise, kind) => assert.rejects(promise, error => { assert.equal(error.name, "SqlError"); assert.equal(error.kind, kind); return true; });

function make(t, { dialect = "postgres", cfg = config(), ...rest } = {}) {
  const driver = fakeDriver({ dialect });
  const events = [], warnings = [];
  const sql = createSql({
    config: cfg, driver, backoff: { minMs: 5, maxMs: 20 },
    logger: { info() {}, warn: m => warnings.push(m), error: m => warnings.push(m) },
    onReady: info => events.push(["ready", info]), onDown: () => events.push(["down"]), ...rest,
  });
  t.after(() => sql.close());
  return { sql, driver, state: driver.state, events, warnings };
}

test("without a database configured: not ready, queries reject NOT_READY immediately", async () => {
  const sql = createSql({ config: loadConfig({}, { envFile: null }) });
  assert.equal(sql.isReady(), false);
  assert.equal(sql.dialect, null);
  await rejects(sql.query("SELECT 1"), "NOT_READY");
  await rejects(sql.transaction(async () => 1), "NOT_READY");
  await rejects(sql.withLock("x", async () => 1), "NOT_READY");
  await rejects(sql.awaitConnection(50), "NOT_READY");
  await sql.close();
  await sql.close();
});

test("the exported API object is frozen and exposes the documented functions", async t => {
  const { sql } = make(t);
  assert.ok(Object.isFrozen(sql));
  for (const name of ["query", "single", "scalar", "insert", "update", "prepare", "rawExecute", "transaction", "isReady", "awaitConnection", "withLock", "close"]) {
    assert.equal(typeof sql[name], "function", name);
  }
  assert.equal(sql.dialect, "postgres");
  assert.throws(() => { "use strict"; sql.query = null; }, TypeError);
});

test("initial probe makes it ready, emits onReady once, and releases awaitConnection", async t => {
  const { sql, state, events } = make(t);
  assert.equal(await sql.awaitConnection(1000), true);
  assert.equal(sql.isReady(), true);
  assert.deepEqual(events.filter(e => e[0] === "ready"), [["ready", { dialect: "postgres" }]]);
  assert.equal(await sql.awaitConnection(), true);
});

test("awaitConnection resolves when the database comes up and rejects with TIMEOUT otherwise", async t => {
  const driver = fakeDriver();
  driver.state.down = true;
  const sql = createSql({ config: config(), driver, backoff: { minMs: 5, maxMs: 20 } });
  t.after(() => sql.close());
  assert.equal(sql.isReady(), false);
  await rejects(sql.awaitConnection(40), "TIMEOUT");
  const waiting = sql.awaitConnection(2000);
  driver.state.down = false;
  assert.equal(await waiting, true);
  assert.equal(sql.isReady(), true);
});

test("queries are rejected with NOT_READY while the database is down", async t => {
  const driver = fakeDriver();
  driver.state.down = true;
  const sql = createSql({ config: config(), driver, backoff: { minMs: 5, maxMs: 20 } });
  t.after(() => sql.close());
  await rejects(sql.query("SELECT 1"), "NOT_READY");
  await rejects(sql.transaction(async () => 1), "NOT_READY");
});

test("a connection failure marks the resource down, then it recovers by itself with backoff", async t => {
  const { sql, state, events } = make(t);
  await sql.awaitConnection(1000);
  state.down = true;
  await rejects(sql.query("SELECT 1"), "CONNECTION");
  assert.equal(sql.isReady(), false);
  assert.deepEqual(events.map(e => e[0]), ["ready", "down"]);
  await rejects(sql.query("SELECT 1"), "NOT_READY");
  await wait(40); // several failed probes with backoff
  assert.ok(state.pings >= 3, "probes keep running while down");
  state.down = false;
  await until(() => sql.isReady());
  assert.deepEqual(events.map(e => e[0]), ["ready", "down", "ready"]);
  assert.deepEqual(await sql.query("SELECT 1"), { affectedRows: 1, insertId: null, changedRows: 1 });
});

test("non connection errors do not take the resource down", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.fail = () => Object.assign(new Error("boom secret-value"), { code: "23505", constraint: "uq" });
  await assert.rejects(sql.query("SELECT 1"), error => error.kind === "UNIQUE_VIOLATION" && error.constraint === "uq" && !error.message.includes("secret-value"));
  assert.equal(sql.isReady(), true);
});

test("result formats: rows array, header object, single, scalar, update", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.results.push([{ a: 1 }, { a: 2 }]);
  assert.deepEqual(await sql.query("SELECT a FROM t"), [{ a: 1 }, { a: 2 }]);
  state.results.push([{ a: 1 }, { a: 2 }]);
  assert.deepEqual(await sql.single("SELECT a FROM t"), { a: 1 });
  state.results.push([]);
  assert.equal(await sql.single("SELECT a FROM t"), null);
  state.results.push({ affectedRows: 1, insertId: null, changedRows: 1 });
  assert.equal(await sql.single("UPDATE t SET a = 1"), null);
  state.results.push([{ total: "7", other: 1 }]);
  assert.equal(await sql.scalar("SELECT count(*) AS total, 1 AS other FROM t"), "7");
  state.results.push([]);
  assert.equal(await sql.scalar("SELECT a FROM t"), null);
  state.results.push([{ v: null }]);
  assert.equal(await sql.scalar("SELECT v FROM t"), null);
  state.results.push({ affectedRows: 3, insertId: null, changedRows: 2 });
  assert.equal(await sql.update("DELETE FROM t WHERE a > ?", [1]), 3);
  state.results.push([{ id: 1 }, { id: 2 }]);
  assert.equal(await sql.update("UPDATE t SET a = 1 RETURNING id"), 2);
});

test("insert: PostgreSQL appends RETURNING and returns a string id", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.results.push([{ id: "42" }]);
  assert.equal(await sql.insert("INSERT INTO t(a) VALUES (?);", [1]), "42");
  assert.equal(state.log.at(-1).text, 'INSERT INTO t(a) VALUES ($1)\nRETURNING "id"');
  state.results.push([{ id: 7 }]);
  assert.equal(await sql.insert("INSERT INTO t(a) VALUES (?) -- trailing", [1]), "7");
  assert.equal(state.log.at(-1).text, 'INSERT INTO t(a) VALUES ($1) -- trailing\nRETURNING "id"');
  state.results.push([{ uid: "9" }]);
  assert.equal(await sql.insert("INSERT INTO t(a) VALUES (?)", [1], { returning: "uid" }), "9");
  assert.ok(state.log.at(-1).text.endsWith('RETURNING "uid"'));
  state.results.push([{ id: "5" }]);
  await sql.insert("INSERT INTO t(a) VALUES (?) RETURNING id", [1]);
  assert.equal(state.log.at(-1).text, "INSERT INTO t(a) VALUES ($1) RETURNING id");
  state.results.push([]);
  assert.equal(await sql.insert("INSERT INTO t(a) VALUES (?) ON CONFLICT DO NOTHING", [1]), null);
});

test("insert: MySQL uses insertId from the header and does not touch the SQL", async t => {
  const { sql, state } = make(t, { dialect: "mysql", cfg: config({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@h/db" }) });
  await sql.awaitConnection(1000);
  state.results.push({ affectedRows: 1, insertId: "123456789012345678", changedRows: 0 });
  assert.equal(await sql.insert("INSERT INTO t(a) VALUES (?)", [1]), "123456789012345678");
  assert.equal(state.log.at(-1).text, "INSERT INTO t(a) VALUES (?)");
  state.results.push({ affectedRows: 0, insertId: null, changedRows: 0 });
  assert.equal(await sql.insert("INSERT INTO t(a) VALUES (?)", [1]), null);
});

test("insert validates the statement type and the returning column (SQL injection guard)", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  await rejects(sql.insert("UPDATE t SET a = 1"), "INSERT_REQUIRED");
  await rejects(sql.insert("SELECT 1"), "INSERT_REQUIRED");
  for (const bad of ['id"; DROP TABLE t; --', "id name", "1id", "", "a".repeat(64), 5, "id,other"]) {
    await rejects(sql.insert("INSERT INTO t(a) VALUES (1)", [], { returning: bad }), "INVALID_PARAMS");
  }
  assert.equal(state.log.length, 0, "nothing reached the driver");
});

test("prepare runs as a prepared statement; query does not", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  await sql.prepare("SELECT ?", [1]);
  assert.equal(state.log.at(-1).options.prepared, true);
  await sql.query("SELECT ?", [1]);
  assert.equal(state.log.at(-1).options.prepared, false);
});

test("rawExecute runs the parameter sets serially on one connection", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.results.push([{ a: 1 }], { affectedRows: 1, insertId: null, changedRows: 1 });
  const out = await sql.rawExecute("SELECT ?", [[1], [2]]);
  assert.deepEqual(out, [[{ a: 1 }], { affectedRows: 1, insertId: null, changedRows: 1 }]);
  assert.deepEqual(labels(state), ["conn", "conn"]);
  assert.deepEqual(state.released, [{ id: 1, broken: false }]);
  assert.deepEqual(await sql.rawExecute("SELECT ?", []), []);
  await rejects(sql.rawExecute("SELECT ?", "nope"), "INVALID_PARAMS");
  await rejects(sql.rawExecute("SELECT ?", [[1], []]), "INVALID_PARAMS");
  assert.equal(state.log.length, 2, "an invalid set aborts before any statement runs");
  assert.equal(state.active, 0);
});

test("transaction(fn): commit on resolve, value returned, connection released", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.results.push([{ id: "1" }]);
  const value = await sql.transaction(async tx => { const row = await tx.single("SELECT id FROM t"); return { got: row.id }; });
  assert.deepEqual(value, { got: "1" });
  assert.deepEqual(labels(state), ["begin", "conn", "commit"]);
  assert.deepEqual(state.released, [{ id: 1, broken: false }]);
});

test("transaction(fn): rollback when fn rejects and the original error is rethrown", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  const original = new Error("business rule failed");
  await assert.rejects(sql.transaction(async tx => { await tx.query("SELECT 1"); throw original; }), error => error === original);
  assert.deepEqual(labels(state), ["begin", "conn", "rollback"]);
  assert.equal(state.active, 0);
});

test("transaction(fn): a failing statement rolls back and rejects with a SqlError", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.fail = text => /BAD/.test(text) ? Object.assign(new Error("x"), { code: "23503", constraint: "fk" }) : undefined;
  await assert.rejects(sql.transaction(async tx => { await tx.query("SELECT 1"); await tx.query("SELECT BAD"); }),
    error => error.kind === "FOREIGN_KEY_VIOLATION" && error.constraint === "fk");
  assert.ok(labels(state).includes("rollback"));
  assert.ok(!labels(state).includes("commit"));
});

test("transaction(fn): a failing COMMIT triggers rollback and a SqlError", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.failCommit = Object.assign(new Error("commit failed"), { code: "40001" });
  await rejects(sql.transaction(async tx => { await tx.query("SELECT 1"); return 1; }), "DEADLOCK");
  assert.deepEqual(labels(state), ["begin", "conn", "commit", "rollback"]);
});

test("transaction(fn): a dead connection discards the connection (release broken) and flips to down", async t => {
  const { sql, state, events } = make(t);
  await sql.awaitConnection(1000);
  await rejects(sql.transaction(async tx => { state.down = true; await tx.query("SELECT 1"); }), "CONNECTION");
  assert.equal(state.released.at(-1).broken, true);
  assert.equal(sql.isReady(), false);
  assert.equal(events.at(-1)[0], "down");
});

test("the tx object is unusable after the transaction ends; nested transactions fail clearly", async t => {
  const { sql } = make(t);
  await sql.awaitConnection(1000);
  let leaked;
  await sql.transaction(async tx => { leaked = tx; });
  await rejects(leaked.query("SELECT 1"), "OTHER");
  await rejects(leaked.single("SELECT 1"), "OTHER");
  await assert.rejects(sql.transaction(async tx => tx.transaction(async () => 1)), error => error.kind === "OTHER" && /Nested/.test(error.message));
  await sql.transaction(async tx => { assert.ok(Object.isFrozen(tx)); });
});

test("transaction([...]) runs every statement then returns true; an invalid entry fails before BEGIN", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  assert.equal(await sql.transaction([{ query: "INSERT INTO t(a) VALUES (?)", values: [1] }, { query: "UPDATE t SET a = :a", values: { a: 2 } }]), true);
  assert.deepEqual(labels(state), ["begin", "conn", "conn", "commit"]);
  assert.deepEqual(state.log[1].values, [1]);
  state.log.length = 0;
  await rejects(sql.transaction([{ query: "UPDATE t SET a = ?", values: [] }]), "INVALID_PARAMS");
  await rejects(sql.transaction([{ nope: 1 }]), "INVALID_PARAMS");
  await rejects(sql.transaction("SELECT 1"), "INVALID_PARAMS");
  assert.equal(state.log.length, 0);
  state.fail = text => /FAIL/.test(text) ? Object.assign(new Error("x"), { code: "42601" }) : undefined;
  await rejects(sql.transaction([{ query: "SELECT 1" }, { query: "SELECT FAIL" }]), "SYNTAX");
  assert.ok(labels(state).includes("rollback"));
});

test("withLock: same name runs serially, different names run in parallel", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  const order = [];
  const job = (name, label, ms) => sql.withLock(name, async () => { order.push("start " + label); await wait(ms); order.push("end " + label); return label; });
  const same = await Promise.all([job("a", "1", 30), job("a", "2", 5), job("a", "3", 5)]);
  assert.deepEqual(same, ["1", "2", "3"]);
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  order.length = 0;
  await Promise.all([job("a", "x", 30), job("b", "y", 30)]);
  assert.deepEqual(order.slice(0, 2).sort(), ["start x", "start y"], "different names overlap");
  assert.ok(state.maxActive >= 2);
  assert.equal(state.active, 0);
});

test("withLock: always unlocks and releases, also when fn rejects; the tx scope is dead afterwards", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  const boom = new Error("fn failed");
  let scope;
  await assert.rejects(sql.withLock("job", async tx => { scope = tx; await tx.query("SELECT 1"); throw boom; }), error => error === boom);
  assert.deepEqual(labels(state), ["lock", "conn", "unlock"]);
  assert.equal(state.active, 0);
  await rejects(scope.query("SELECT 1"), "OTHER");
  assert.equal(await sql.withLock("job", async () => "again"), "again"); // not stuck
});

test("withLock: timeout when the lock cannot be obtained, in the database or in process", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.denyLock = true;
  await rejects(sql.withLock("db", async () => 1, 30), "TIMEOUT");
  assert.equal(state.active, 0);
  assert.ok(!labels(state).includes("unlock"), "a lock that was never acquired is never released");
  state.denyLock = false;
  const slow = sql.withLock("p", () => wait(120));
  await wait(5);
  await rejects(sql.withLock("p", async () => 1, 20), "TIMEOUT");
  await slow;
  assert.equal(await sql.withLock("p", async () => "free"), "free");
});

test("withLock validates its arguments", async t => {
  const { sql } = make(t);
  await sql.awaitConnection(1000);
  await rejects(sql.withLock("", async () => 1), "INVALID_PARAMS");
  await rejects(sql.withLock("x".repeat(65), async () => 1), "INVALID_PARAMS");
  await rejects(sql.withLock("x", null), "INVALID_PARAMS");
  await rejects(sql.withLock("x", async () => 1, -1), "INVALID_PARAMS");
  assert.equal(await sql.withLock("x".repeat(64), async () => "ok"), "ok");
});

test("slow queries are logged with truncated SQL and no values", async t => {
  let now = 0;
  const { sql, state, warnings } = make(t, { cfg: config({ MS_SQL_SLOW_QUERY_MS: "100" }), clock: () => now });
  await sql.awaitConnection(1000);
  state.runDelay = 1;
  const original = state.fail;
  state.fail = () => { now += 150; return original?.(); };
  await sql.query("SELECT   name\nFROM t WHERE secret = ? " + "x".repeat(300), ["super-secret-value"]);
  const slow = warnings.filter(w => w.startsWith("Slow query"));
  assert.equal(slow.length, 1);
  assert.ok(!slow[0].includes("super-secret-value"));
  assert.ok(slow[0].includes("SELECT name FROM t WHERE secret = ?"));
  assert.ok(slow[0].length < 260);
  state.fail = () => { now += 5; };
  await sql.query("SELECT 1");
  assert.equal(warnings.filter(w => w.startsWith("Slow query")).length, 1, "fast queries are not logged");
});

test("slow query logging is off when MS_SQL_SLOW_QUERY_MS is 0", async t => {
  let now = 0;
  const { sql, state, warnings } = make(t, { cfg: config({ MS_SQL_SLOW_QUERY_MS: "0" }), clock: () => now });
  await sql.awaitConnection(1000);
  state.fail = () => { now += 99999; };
  await sql.query("SELECT 1");
  assert.equal(warnings.filter(w => w.startsWith("Slow query")).length, 0);
});

test("close is idempotent, ends the driver once, rejects waiters and later calls", async t => {
  const driver = fakeDriver();
  driver.state.down = true;
  const sql = createSql({ config: config(), driver, backoff: { minMs: 5, maxMs: 20 } });
  const waiting = sql.awaitConnection(5000);
  await Promise.all([sql.close(), sql.close()]);
  await sql.close();
  assert.equal(driver.state.ended, 1);
  await rejects(waiting, "NOT_READY");
  await rejects(sql.query("SELECT 1"), "NOT_READY");
  assert.equal(sql.isReady(), false);
  const pings = driver.state.pings;
  await wait(40);
  assert.equal(driver.state.pings, pings, "no more probes after close");
});

test("a throwing onReady callback does not break the API", async t => {
  const driver = fakeDriver();
  const sql = createSql({ config: config(), driver, onReady() { throw new Error("listener bug"); }, logger: { info() {}, warn() {}, error() {} } });
  t.after(() => sql.close());
  assert.equal(await sql.awaitConnection(1000), true);
});

test("a client-side query timeout inside a transaction discards the connection and skips the hung ROLLBACK", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.fail = text => /HUNG/.test(text) ? new Error("Query read timeout") : undefined;
  await rejects(sql.transaction(async tx => { await tx.query("SELECT HUNG"); }), "TIMEOUT");
  assert.ok(!labels(state).includes("rollback"));
  assert.equal(state.released.at(-1).broken, true);
  assert.equal(sql.isReady(), true); // a timeout is not a lost connection
});

test("a server-side timeout (57014) keeps the connection and still rolls back", async t => {
  const { sql, state } = make(t);
  await sql.awaitConnection(1000);
  state.fail = text => /SLOW/.test(text) ? Object.assign(new Error("canceling statement"), { code: "57014" }) : undefined;
  await rejects(sql.transaction(async tx => { await tx.query("SELECT SLOW"); }), "TIMEOUT");
  assert.ok(labels(state).includes("rollback"));
  assert.equal(state.released.at(-1).broken, false);
});

test("withLock: a client-side timeout inside the scope discards the connection without unlock", async t => {
  const { sql, state } = make(t, { dialect: "mysql", cfg: config({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@h/db" }) });
  await sql.awaitConnection(1000);
  state.fail = text => /HUNG/.test(text) ? Object.assign(new Error("timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" }) : undefined;
  await assert.rejects(sql.withLock("job", async db => { await db.query("SELECT HUNG"); }), error => error.kind === "TIMEOUT");
  assert.ok(!labels(state).includes("unlock"));
  assert.equal(state.released.at(-1).broken, true);
});
