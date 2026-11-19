"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMysqlDriver } = require("../server/drivers/mysql");
const { loadConfig } = require("../server/config");
const { describeDialect } = require("./helpers/dialects");

const cfg = (url, extra = {}) => loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: url, ...extra }, { envFile: null });

// ---------------------------------------------------------------- unit tests with a fake mysql2
function fakeMysql({ results = [], hang = false } = {}) {
  const log = { options: null, listeners: {}, sessionSql: [], requests: [], released: 0, destroyed: 0, ended: 0, connections: [] };
  const makeConnection = () => ({
    query(request, callback) {
      if (typeof request === "string") { log.sessionSql.push(request); callback?.(null); return; }
      log.requests.push({ via: "query", ...request });
      return Promise.resolve(results.length ? results.shift() : [{ affectedRows: 1, insertId: 0, changedRows: 0 }, undefined]);
    },
    execute(request) { log.requests.push({ via: "execute", ...request }); return Promise.resolve(results.length ? results.shift() : [{ affectedRows: 1, insertId: 0, changedRows: 0 }, undefined]); },
    release() { log.released++; }, destroy() { log.destroyed++; },
  });
  const lib = {
    createPool(options) {
      log.options = options;
      return {
        pool: { on: (event, handler) => { log.listeners[event] = handler; } },
        getConnection: () => hang ? new Promise(() => {}) : Promise.resolve(makeConnection()),
        end: async () => { log.ended++; },
      };
    },
  };
  return { lib, log };
}
const field = (name, orgName, columnType = 252) => ({ name, orgName, columnType, schema: "ms_db", orgTable: "tbl" });

test("pool is created with the options required by the plan", () => {
  const { lib, log } = fakeMysql();
  createMysqlDriver(cfg("mysql://us%40er:p%23ss@db.example:3307/ignored_db", { MS_SQL_POOL_SIZE: "9", MS_SQL_QUERY_TIMEOUT_MS: "4000", MS_SQL_SSL: "true" }), { mysql: lib });
  const o = log.options;
  assert.equal(o.host, "db.example");
  assert.equal(o.port, 3307);
  assert.equal(o.user, "us@er");
  assert.equal(o.password, "p#ss");
  assert.equal(o.database, "ms_test", "the pool connects to the schema, not to the URL path");
  assert.equal(o.connectionLimit, 9);
  assert.equal(o.connectTimeout, 4000);
  assert.equal(o.supportBigNumbers, true);
  assert.equal(o.bigNumberStrings, true);
  assert.equal(o.timezone, "Z");
  assert.equal(o.charset, "utf8mb4");
  assert.equal(o.multipleStatements, false);
  assert.ok(o.flags.includes("+FOUND_ROWS"));
  assert.deepEqual(o.ssl, { rejectUnauthorized: true });
});

test("defaults: port 3306, TLS off, database taken from MS_SQL_SCHEMA", () => {
  const { lib, log } = fakeMysql();
  createMysqlDriver(cfg("mariadb://u:p@127.0.0.1"), { mysql: lib });
  assert.equal(log.options.port, 3306);
  assert.equal(log.options.database, "ms_test");
  assert.equal(log.options.ssl, undefined);
});

test("dialect is mysql or mariadb according to the URL", () => {
  assert.equal(createMysqlDriver(cfg("mysql://u:p@h/db"), { mysql: fakeMysql().lib }).dialect, "mysql");
  assert.equal(createMysqlDriver(cfg("mariadb://u:p@h/db"), { mysql: fakeMysql().lib }).dialect, "mariadb");
});

test("every new connection gets READ COMMITTED and UTC; a failing setup discards it", () => {
  const { lib, log } = fakeMysql();
  createMysqlDriver(cfg("mysql://u:p@h/db"), { mysql: lib });
  const calls = [];
  const connection = { query: (sql, callback) => { calls.push(sql); callback(null, /^SELECT @@SESSION/.test(sql) ? [{ sql_mode: "STRICT_ALL_TABLES" }] : undefined); }, destroy: () => calls.push("destroyed") };
  log.listeners.connection(connection);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(0, 2), ["SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED", "SET time_zone = '+00:00'"]);
  // SEC-01 / R-04: one statement drops NO_BACKSLASH_ESCAPES and ANSI_QUOTES, keeps the rest and adds STRICT_ALL_TABLES.
  assert.match(calls[2], /^SET SESSION sql_mode = /);
  assert.ok(calls[2].includes("@@sql_mode") && calls[2].includes("NO_BACKSLASH_ESCAPES") && calls[2].includes("ANSI_QUOTES") && calls[2].includes("STRICT_ALL_TABLES"));
  assert.equal(calls[3], "SELECT @@SESSION.sql_mode AS sql_mode");
  assert.ok(!calls.includes("destroyed"), "a confirmed safe mode keeps the connection");
  const bad = { query: (sql, callback) => callback(new Error("denied")), destroy: () => calls.push("destroyed") };
  log.listeners.connection(bad);
  assert.ok(calls.includes("destroyed"));
});

test("R-04: the session mode is confirmed and the connection is destroyed when it is not safe", () => {
  const { lib, log } = fakeMysql();
  createMysqlDriver(cfg("mysql://u:p@h/db"), { mysql: lib });
  const attempt = confirm => {
    let destroyed = 0;
    log.listeners.connection({ query: (sql, callback) => { if (/^SELECT @@SESSION/.test(sql)) confirm(callback); else callback(null); }, destroy: () => { destroyed++; } });
    return destroyed;
  };
  assert.equal(attempt(cb => cb(null, [{ sql_mode: "ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES" }])), 0);
  assert.equal(attempt(cb => cb(null, [{ sql_mode: "STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES" }])), 1, "NO_BACKSLASH_ESCAPES still set");
  assert.equal(attempt(cb => cb(null, [{ sql_mode: "ANSI_QUOTES,STRICT_ALL_TABLES" }])), 1, "ANSI_QUOTES still set");
  assert.equal(attempt(cb => cb(null, [{ sql_mode: "STRICT_TRANS_TABLES" }])), 1, "STRICT_ALL_TABLES missing");
  assert.equal(attempt(cb => cb(null, [{ sql_mode: "" }])), 1, "empty mode");
  assert.equal(attempt(cb => cb(null, [])), 1, "no row");
  assert.equal(attempt(cb => cb(new Error("lost"))), 1, "confirmation failed");
});

test("rows come back as an array, headers are normalized with a string insertId", async () => {
  const { lib, log } = fakeMysql({ results: [[[{ a: 1 }], []], [{ affectedRows: 2, insertId: 321, changedRows: 1 }], [{ affectedRows: 0, insertId: 0, changedRows: 0 }], [{ affectedRows: 1, insertId: "9007199254740993" }]] });
  const driver = createMysqlDriver(cfg("mysql://u:p@h/db", { MS_SQL_QUERY_TIMEOUT_MS: "3000" }), { mysql: lib });
  assert.deepEqual(await driver.run("SELECT a FROM t", []), [{ a: 1 }]);
  assert.deepEqual(await driver.run("UPDATE t SET a = 1", []), { affectedRows: 2, insertId: "321", changedRows: 1 });
  assert.deepEqual(await driver.run("UPDATE t SET a = 1", []), { affectedRows: 0, insertId: null, changedRows: 0 });
  assert.deepEqual(await driver.run("INSERT INTO t VALUES (1)", []), { affectedRows: 1, insertId: "9007199254740993", changedRows: 0 });
  assert.equal(log.requests[0].timeout, 3000, "per request timeout");
  assert.equal(log.released, 4);
});

test("prepared statements use execute; plain ones use query", async () => {
  const { lib, log } = fakeMysql();
  const driver = createMysqlDriver(cfg("mysql://u:p@h/db"), { mysql: lib });
  await driver.run("SELECT ?", [1], { prepared: true });
  await driver.run("SELECT ?", [1], { prepared: false });
  assert.deepEqual(log.requests.map(r => r.via), ["execute", "query"]);
});

test("MariaDB: JSON columns (LONGTEXT alias) are parsed, other text columns are not", async () => {
  const rows = [{ id: "1", data: '{"a":[1,2]}', note: '{"looks":"like json"}', other: null }, { id: "2", data: "not json", note: "x", other: null }];
  const { lib, log } = fakeMysql({ results: [[rows, [field("id", "id", 8), field("data", "data"), field("note", "note")]], [[{ CHECK_CLAUSE: "json_valid(`data`)" }], []]] });
  const driver = createMysqlDriver(cfg("mariadb://u:p@h/db"), { mysql: lib });
  const out = await driver.run("SELECT id, data, note FROM tbl", []);
  assert.deepEqual(out[0].data, { a: [1, 2] });
  assert.equal(out[0].note, '{"looks":"like json"}');
  assert.equal(out[1].data, "not json", "invalid JSON is left as text");
  assert.match(log.requests[1].sql, /information_schema\.CHECK_CONSTRAINTS/);
  assert.deepEqual(log.requests[1].values, ["ms_db", "tbl"]);
});

test("MariaDB: the JSON column lookup is cached per table, and aliased columns use the original name", async () => {
  const mk = () => [[{ j: '{"x":1}' }], [field("j", "data")]];
  const { lib, log } = fakeMysql({ results: [mk(), [[{ CHECK_CLAUSE: "json_valid(`data`)" }], []], mk()] });
  const driver = createMysqlDriver(cfg("mariadb://u:p@h/db"), { mysql: lib });
  assert.deepEqual((await driver.run("SELECT data AS j FROM tbl", []))[0].j, { x: 1 });
  assert.deepEqual((await driver.run("SELECT data AS j FROM tbl", []))[0].j, { x: 1 });
  assert.equal(log.requests.filter(r => /CHECK_CONSTRAINTS/.test(r.sql)).length, 1);
});

test("MySQL (not MariaDB) never runs the JSON lookup", async () => {
  const { lib, log } = fakeMysql({ results: [[[{ data: '{"a":1}' }], [field("data", "data")]]] });
  const driver = createMysqlDriver(cfg("mysql://u:p@h/db"), { mysql: lib });
  assert.deepEqual(await driver.run("SELECT data FROM tbl", []), [{ data: '{"a":1}' }]);
  assert.equal(log.requests.length, 1);
});

test("MariaDB: a failing JSON lookup leaves the rows untouched", async () => {
  const { lib } = fakeMysql({ results: [[[{ data: '{"a":1}' }], [field("data", "data")]]] });
  const driver = createMysqlDriver(cfg("mariadb://u:p@h/db"), { mysql: lib });
  // The second query (the lookup) is the default header result, i.e. not an array: it must be tolerated.
  assert.deepEqual(await driver.run("SELECT data FROM tbl", []), [{ data: '{"a":1}' }]);
});

test("a fatal error discards the connection; an ordinary one returns it to the pool", async () => {
  const fake = fakeMysql();
  const failing = createMysqlDriver(cfg("mysql://u:p@h/db"), { mysql: { createPool: options => {
    const pool = fake.lib.createPool(options);
    const get = pool.getConnection;
    pool.getConnection = async () => { const c = await get(); c.query = () => Promise.reject(Object.assign(new Error("lost"), { code: "PROTOCOL_CONNECTION_LOST", fatal: true })); return c; };
    return pool;
  } } });
  await assert.rejects(failing.run("SELECT 1", []), error => error.code === "PROTOCOL_CONNECTION_LOST");
  assert.equal(fake.log.destroyed, 1);
  assert.equal(fake.log.released, 0);
  const healthy = fakeMysql();
  await createMysqlDriver(cfg("mysql://u:p@h/db"), { mysql: healthy.lib }).run("SELECT 1", []);
  assert.equal(healthy.log.destroyed, 0);
  assert.equal(healthy.log.released, 1);
});

test("acquiring a connection from an exhausted pool times out instead of waiting forever", async () => {
  const { lib } = fakeMysql({ hang: true });
  const driver = createMysqlDriver(cfg("mysql://u:p@h/db", { MS_SQL_QUERY_TIMEOUT_MS: "100" }), { mysql: lib });
  const started = Date.now();
  await assert.rejects(driver.run("SELECT 1", []), error => error.code === "POOL_ACQUIRE_TIMEOUT");
  await assert.rejects(driver.acquire(), error => error.code === "POOL_ACQUIRE_TIMEOUT");
  await assert.rejects(driver.ping(), error => error.code === "POOL_ACQUIRE_TIMEOUT");
  assert.ok(Date.now() - started < 2000);
});

test("transaction verbs, GET_LOCK and RELEASE_LOCK on a dedicated connection", async () => {
  const { lib, log } = fakeMysql({ results: [[[{ ok: 1 }], []], [[{ ok: 0 }], []]] });
  const driver = createMysqlDriver(cfg("mariadb://u:p@h/db"), { mysql: lib });
  const conn = await driver.acquire();
  await conn.begin(); await conn.commit(); await conn.rollback();
  assert.deepEqual(log.sessionSql.slice(-3), ["START TRANSACTION", "COMMIT", "ROLLBACK"]);
  assert.equal(await conn.lock("my-lock", 1500), true);
  assert.equal(await conn.lock("my-lock", 1500), false);
  const get = log.requests.filter(r => /GET_LOCK/.test(r.sql ?? ""));
  assert.deepEqual(get[0].values, ["my-lock", 1.5]);
  await conn.unlock("my-lock");
  assert.match(log.requests.at(-1).sql, /RELEASE_LOCK/);
  conn.release(); conn.release(true);
  assert.equal(log.released, 1);
  assert.equal(log.destroyed, 1);
  await driver.end();
  assert.equal(log.ended, 1);
});

// ---------------------------------------------------------------- real servers (skipped without a URL)
for (const name of ["mysql", "mariadb"]) {
  const target = describeDialect(name);
  test(`[${name}] real server: driver contract`, { skip: target.skip ? `${name} server tests skipped: ${target.skip}` : false }, async t => {
    const db = await target.start();
    const driver = createMysqlDriver(loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: db.url, MS_SQL_POOL_SIZE: "3" }, { envFile: null }));
    t.after(() => driver.end());
    await driver.ping();
    await driver.run("DROP TABLE IF EXISTS d_items", []);
    await driver.run("CREATE TABLE d_items (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) COLLATE utf8mb4_bin, big BIGINT, data JSON, qty INT DEFAULT 0, at DATETIME(3)) ENGINE=InnoDB", []);
    t.after(() => driver.run("DROP TABLE IF EXISTS d_items", []));
    const insert = await driver.run("INSERT INTO d_items(name, big, data, at) VALUES (?, ?, ?, ?)", ["a", "9007199254740993", JSON.stringify({ k: [1] }), new Date("2026-01-02T03:04:05.678Z")]);
    assert.equal(insert.insertId, "1");
    assert.equal(typeof insert.insertId, "string");
    const rows = await driver.run("SELECT * FROM d_items", []);
    assert.equal(rows[0].big, "9007199254740993");
    assert.deepEqual(rows[0].data, { k: [1] });
    assert.equal(rows[0].at.toISOString(), "2026-01-02T03:04:05.678Z");
    assert.equal((await driver.run("UPDATE d_items SET qty = 0 WHERE id = ?", [1])).affectedRows, 1, "FOUND_ROWS: matched rows count");
    assert.equal((await driver.run("UPDATE d_items SET qty = 0 WHERE id = ?", [1], { prepared: true })).affectedRows, 1);
    const [{ iso }] = await driver.run("SELECT @@transaction_isolation AS iso", []).catch(() => driver.run("SELECT @@tx_isolation AS iso", []));
    assert.equal(iso, "READ-COMMITTED");
    await assert.rejects(driver.run("INSERT INTO d_items(name) VALUES (?)", ["a"]).then(() => driver.run("INSERT INTO d_items(id) VALUES (?)", [1])), error => error.errno === 1062);
    const conn = await driver.acquire();
    try {
      assert.equal(await conn.lock("driver-test", 200), true);
      await conn.unlock("driver-test");
    } finally { conn.release(); }
  });
}
