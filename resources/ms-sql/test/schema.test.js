"use strict";
// MS_SQL_SCHEMA: the schema (PostgreSQL) or database (MySQL/MariaDB) is created once by ms-sql and every
// connection resolves unqualified table names inside it.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DIALECTS, connect, DDL } = require("./helpers/dialects");
const { createSql } = require("../server");
const { createMysqlDriver } = require("../server/drivers/mysql");
const { createPostgresDriver } = require("../server/drivers/postgres");
const { loadConfig } = require("../server/config");
const { fakeDriver } = require("./helpers/fake-driver");

const cfg = extra => loadConfig({ MS_SQL_URL: "postgres://u:p@h/db", MS_SQL_SCHEMA: "ms_test", ...extra }, { envFile: null });
const quiet = { info() {}, warn() {}, error() {} };

for (const dialect of DIALECTS) {
  describe(`[${dialect.name}] schema`, { skip: dialect.skip ? `${dialect.name} tests skipped: ${dialect.skip}` : false }, () => {
    let db;
    const current = dialect.name === "postgres" ? "SELECT current_schema()" : "SELECT DATABASE()";
    const currentName = dialect.name === "postgres" ? "current_schema()" : "DATABASE()";
    const listed = "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?";
    before(async () => { db = await dialect.start(); });
    after(async () => { await db?.stop(); });

    test("the schema is created, becomes the current one on every connection and unqualified names land in it", async () => {
      const { sql } = connect(db, { MS_SQL_SCHEMA: "ms_schema_a" });
      try {
        await sql.awaitConnection(5000);
        assert.equal(sql.schema, "ms_schema_a");
        assert.equal(await sql.scalar(listed, ["ms_schema_a"]), "ms_schema_a");
        assert.equal(await sql.scalar(current), "ms_schema_a");
        await sql.query(DDL[dialect.name].create);
        assert.equal(await sql.scalar(`SELECT table_schema FROM information_schema.tables WHERE table_name = 't_items' AND table_schema = ${currentName}`), "ms_schema_a");
        // Every pooled connection (not only the first) and every scope sees the same schema.
        const seen = await Promise.all(Array.from({ length: 6 }, (_, i) => sql.withLock("schema-test-" + i, tx => tx.scalar(current))));
        assert.deepEqual([...new Set(seen)], ["ms_schema_a"]);
        assert.equal(await sql.transaction(tx => tx.scalar(current)), "ms_schema_a");
      } finally { await sql.close(); }
    });

    test("creation is idempotent: a second instance reuses the schema and keeps its tables", async () => {
      const first = connect(db, { MS_SQL_SCHEMA: "ms_schema_b" }).sql;
      await first.awaitConnection(5000);
      await first.query(DDL[dialect.name].create);
      await first.insert("INSERT INTO t_items (name) VALUES (?)", ["keep"]);
      await first.close();
      const second = connect(db, { MS_SQL_SCHEMA: "ms_schema_b" }).sql;
      try {
        await second.awaitConnection(5000);
        assert.equal(await second.scalar("SELECT name FROM t_items"), "keep");
      } finally { await second.close(); }
    });

    test("tables of another schema are not visible without a prefix", async () => {
      const { sql } = connect(db, { MS_SQL_SCHEMA: "ms_schema_c" });
      try {
        await sql.awaitConnection(5000);
        const other = dialect.name === "postgres" ? "ms_schema_other" : "ms_schema_other";
        if (dialect.name === "postgres") await sql.query('CREATE SCHEMA IF NOT EXISTS "' + other + '"');
        else await sql.query("CREATE DATABASE IF NOT EXISTS `" + other + "`");
        await sql.query(DDL[dialect.name].create.replace("t_items", other + ".t_items"));
        await assert.rejects(sql.query("SELECT 1 FROM t_items"), error => error.name === "SqlError");
        assert.equal(await sql.scalar("SELECT COUNT(*) FROM " + other + ".t_items"), dialect.name === "postgres" ? "0" : 0);
      } finally { await sql.close(); }
    });
  });
}

test("loadConfig: an invalid schema never reaches a driver", () => {
  assert.throws(() => cfg({ MS_SQL_SCHEMA: 'x"; DROP SCHEMA public; --' }), /^Error: Invalid MS_SQL_SCHEMA/);
  assert.throws(() => cfg({ MS_SQL_SCHEMA: "" }), /^Error: Invalid MS_SQL_SCHEMA/);
});

test("createSql exposes the schema and runs driver.init before the first ping", async () => {
  const driver = fakeDriver();
  const order = [];
  const { init, ping } = driver;
  driver.init = async () => { order.push("init"); await init(); };
  driver.ping = async () => { order.push("ping"); await ping(); };
  const sql = createSql({ config: cfg(), driver, logger: quiet });
  assert.equal(sql.schema, "ms_test");
  await sql.awaitConnection(1000);
  assert.deepEqual(order.slice(0, 2), ["init", "ping"]);
  await sql.close();
});

test("fail closed: when the schema cannot be created the resource never becomes ready and says why", async () => {
  const driver = fakeDriver();
  driver.state.initFail = Object.assign(new Error("permission denied for database"), { code: "42501" });
  const errors = [];
  const sql = createSql({ config: cfg(), driver, backoff: { minMs: 5, maxMs: 10 }, logger: { info() {}, warn() {}, error: m => errors.push(m) } });
  await assert.rejects(sql.awaitConnection(150), error => error.kind === "TIMEOUT");
  assert.equal(sql.isReady(), false);
  assert.equal(driver.state.pings, 0, "no ping (and no query) before the schema exists");
  await assert.rejects(sql.query("SELECT 1"), error => error.kind === "NOT_READY");
  assert.ok(errors.some(m => m.includes('Cannot create or access schema "ms_test"')));
  assert.ok(driver.state.inits > 1, "keeps retrying");
  driver.state.initFail = null; // permissions fixed: recovers without a restart
  await sql.awaitConnection(1000);
  assert.equal(sql.isReady(), true);
  await sql.close();
});

function fakeMysqlLib(log, { exists = false, createError = null } = {}) {
  return {
    async createConnection(options) {
      log.connections.push(options);
      return {
        async query(request) {
          log.statements.push(request);
          if (/SCHEMATA/.test(request.sql)) return [exists ? [{ 1: 1 }] : [], undefined];
          if (createError) throw createError;
          return [{ affectedRows: 1 }, undefined];
        },
        async end() { log.ended++; },
      };
    },
    createPool(options) { log.pool = options; return { pool: { on() {} }, end: async () => {} }; },
  };
}

test("MySQL/MariaDB bootstrap: a database-less connection creates the database, the pool connects to it", async () => {
  for (const protocol of ["mysql", "mariadb"]) {
    const log = { connections: [], statements: [], pool: null, ended: 0 };
    const driver = createMysqlDriver(loadConfig({ MS_SQL_URL: `${protocol}://us%40er:p%23ss@h:3307/ignored_db`, MS_SQL_SCHEMA: "magic_school_rp" }, { envFile: null }), { mysql: fakeMysqlLib(log) });
    assert.equal(log.pool.database, "magic_school_rp", "the URL path is ignored");
    await driver.init();
    const [bootstrap] = log.connections;
    assert.ok(!("database" in bootstrap), "bootstrap connection has no database");
    assert.equal(bootstrap.user, "us@er");
    assert.equal(bootstrap.port, 3307);
    assert.deepEqual(log.statements.map(s => s.sql), [
      "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      "CREATE DATABASE IF NOT EXISTS `magic_school_rp` CHARACTER SET utf8mb4",
    ]);
    assert.deepEqual(log.statements[0].values, ["magic_school_rp"]);
    assert.equal(log.ended, 1, "the bootstrap connection is always closed");
  }
});

test("MySQL/MariaDB bootstrap: an existing database needs no CREATE; a failing CREATE rejects", async () => {
  const existing = { connections: [], statements: [], ended: 0 };
  await createMysqlDriver(loadConfig({ MS_SQL_URL: "mysql://u:p@h/x", MS_SQL_SCHEMA: "magic" }, { envFile: null }), { mysql: fakeMysqlLib(existing, { exists: true }) }).init();
  assert.equal(existing.statements.length, 1);
  const denied = { connections: [], statements: [], ended: 0 };
  const lib = fakeMysqlLib(denied, { createError: Object.assign(new Error("denied"), { code: "ER_DBACCESS_DENIED_ERROR" }) });
  await assert.rejects(createMysqlDriver(loadConfig({ MS_SQL_URL: "mysql://u:p@h/x", MS_SQL_SCHEMA: "magic" }, { envFile: null }), { mysql: lib }).init(), /denied/);
  assert.equal(denied.ended, 1);
});

test("PostgreSQL pool: the client sets the search_path before it is handed out, and a failing SET rejects the connection", async () => {
  let received;
  class FakePool { constructor(options) { received = options; } on() {} }
  createPostgresDriver(cfg({ MS_SQL_SCHEMA: "magic_school_rp" }), { Pool: FakePool });
  const { Client } = require("pg");
  const sent = [];
  const connect = Client.prototype.connect, query = Client.prototype.query, end = Client.prototype.end;
  let fail = false;
  Client.prototype.connect = function (cb) { if (cb) { cb(); return; } return Promise.resolve(); };
  Client.prototype.query = function (text, cb) { sent.push(text); cb?.(fail ? new Error("boom") : null); };
  Client.prototype.end = function (cb) { sent.push("END"); cb?.(); };
  try {
    const client = new received.Client({});
    await new Promise((resolve, reject) => client.connect(error => error ? reject(error) : resolve()));
    assert.deepEqual(sent, ['SET search_path TO "magic_school_rp"']);
    sent.length = 0; fail = true;
    await assert.rejects(new Promise((resolve, reject) => new received.Client({}).connect(error => error ? reject(error) : resolve())), /boom/);
    assert.deepEqual(sent, ['SET search_path TO "magic_school_rp"', "END"]);
  } finally { Client.prototype.connect = connect; Client.prototype.query = query; Client.prototype.end = end; }
});
