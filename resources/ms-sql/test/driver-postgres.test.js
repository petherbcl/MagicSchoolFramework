"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createPostgresDriver } = require("../server/drivers/postgres");
const { loadConfig } = require("../server/config");
const { describeDialect } = require("./helpers/dialects");

const target = describeDialect("postgres");
let db, driver;

before(async () => {
  db = await target.start();
  driver = createPostgresDriver(loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: db.url, MS_SQL_POOL_SIZE: "3" }, { envFile: null }));
  await driver.init();
  await driver.run("CREATE TABLE d_items (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, big BIGINT, data JSONB, at TIMESTAMPTZ)", []);
});
after(async () => { await driver?.end(); await db?.stop(); });

test("pool options come from the config", () => {
  let received;
  class FakePool { constructor(options) { received = options; } on() {} }
  createPostgresDriver(loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgresql://u:p@h:5432/db", MS_SQL_POOL_SIZE: "7", MS_SQL_QUERY_TIMEOUT_MS: "2500", MS_SQL_SSL: "true" }, { envFile: null }), { Pool: FakePool });
  assert.equal(received.max, 7);
  assert.equal(received.statement_timeout, 2500);
  assert.equal(received.connectionTimeoutMillis, 2500);
  assert.ok(received.query_timeout > 2500, "client side backstop is longer than the server timeout");
  assert.equal(received.application_name, "MagicSchoolRP-ms-sql");
  assert.deepEqual(received.ssl, { rejectUnauthorized: true });
  createPostgresDriver(loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgresql://u:p@h/db" }, { envFile: null }), { Pool: FakePool });
  assert.equal(received.ssl, false);
});

test("the driver reports its dialect and answers a ping", async () => {
  assert.equal(driver.dialect, "postgres");
  await driver.ping();
});

test("statements without a result set return a header; with one, an array of rows", async () => {
  const inserted = await driver.run("INSERT INTO d_items(name) VALUES ($1), ($2)", ["a", "b"]);
  assert.deepEqual(inserted, { affectedRows: 2, insertId: null, changedRows: 2 });
  const rows = await driver.run("SELECT name FROM d_items ORDER BY id", []);
  assert.deepEqual(rows, [{ name: "a" }, { name: "b" }]);
  assert.deepEqual(await driver.run("SELECT name FROM d_items WHERE name = $1", ["zzz"]), []);
  const returned = await driver.run("INSERT INTO d_items(name) VALUES ($1) RETURNING id", ["c"]);
  assert.equal(returned.length, 1);
  assert.equal(typeof returned[0].id, "string", "BIGINT arrives as a decimal string");
  assert.deepEqual(await driver.run("UPDATE d_items SET name = name WHERE name = $1", ["a"]), { affectedRows: 1, insertId: null, changedRows: 1 });
  assert.deepEqual(await driver.run("DELETE FROM d_items WHERE name = $1", ["c"]), { affectedRows: 1, insertId: null, changedRows: 1 });
});

test("BIGINT above 2^53, JSONB and timestamps keep their types", async () => {
  const big = "9007199254740993";
  const at = new Date("2026-01-02T03:04:05.678Z");
  const rows = await driver.run("INSERT INTO d_items(name, big, data, at) VALUES ($1, $2, $3, $4) RETURNING big, data, at", ["typed", big, JSON.stringify({ a: [1, { b: true }] }), at]);
  assert.equal(rows[0].big, big);
  assert.deepEqual(rows[0].data, { a: [1, { b: true }] });
  assert.ok(rows[0].at instanceof Date);
  assert.equal(rows[0].at.getTime(), at.getTime());
});

test("prepared statements reuse a name derived from the SQL and work repeatedly and with different SQL", async () => {
  for (let i = 0; i < 3; i++) assert.deepEqual(await driver.run("SELECT $1::int AS n", [i], { prepared: true }), [{ n: i }]);
  assert.deepEqual(await driver.run("SELECT $1::int + 1 AS n", [1], { prepared: true }), [{ n: 2 }]);
});

test("acquire gives a dedicated connection with transactions", async () => {
  const conn = await driver.acquire();
  try {
    await conn.begin();
    await conn.run("INSERT INTO d_items(name) VALUES ($1)", ["in-tx"]);
    await conn.rollback();
    assert.deepEqual(await conn.run("SELECT name FROM d_items WHERE name = $1", ["in-tx"]), []);
    await conn.begin();
    await conn.run("INSERT INTO d_items(name) VALUES ($1)", ["kept"]);
    await conn.commit();
    assert.equal((await conn.run("SELECT name FROM d_items WHERE name = $1", ["kept"])).length, 1);
  } finally { conn.release(); }
});

test("advisory lock acquire and release on a dedicated connection", async () => {
  const conn = await driver.acquire();
  try {
    assert.equal(await conn.lock("driver-test-lock", 100), true);
    assert.equal(await conn.lock("driver-test-lock", 100), true, "advisory locks are re-entrant in the same session");
    await conn.unlock("driver-test-lock");
    await conn.unlock("driver-test-lock");
  } finally { conn.release(); }
});

test("a released broken connection is discarded and the pool keeps working", async () => {
  const conn = await driver.acquire();
  conn.release(true);
  assert.deepEqual(await driver.run("SELECT 1 AS one", []), [{ one: 1 }]);
});

test("driver errors are raw pg errors with code and constraint (mapping happens in createSql)", async () => {
  await driver.run("CREATE TABLE d_unique (name TEXT CONSTRAINT d_unique_name UNIQUE)", []);
  await driver.run("INSERT INTO d_unique VALUES ($1)", ["x"]);
  await assert.rejects(driver.run("INSERT INTO d_unique VALUES ($1)", ["x"]), error => error.code === "23505" && error.constraint === "d_unique_name");
  await assert.rejects(driver.run("SELEKT 1", []), error => error.code === "42601");
});

test("an unreachable database rejects the ping instead of hanging", async () => {
  const dead = createPostgresDriver(loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgresql://u:p@127.0.0.1:1/db", MS_SQL_QUERY_TIMEOUT_MS: "1000" }, { envFile: null }));
  try { await assert.rejects(dead.ping(), error => error.code === "ECONNREFUSED" || /timeout|ECONN/i.test(error.message + error.code)); }
  finally { await dead.end(); }
});
