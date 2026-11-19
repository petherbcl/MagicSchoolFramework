"use strict";
// Regression tests for the security audit findings SEC-01, 02, 06, 07, 09 and 10.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { loadConfig } = require("../server/config");
const { createPostgresDriver } = require("../server/drivers/postgres");
const { createMysqlDriver } = require("../server/drivers/mysql");
const { createSql } = require("../server");
const { mapError } = require("../server/errors");
const { translate } = require("../server/placeholders");
const { start } = require("../server/runtime");
const { fakeDriver, labels } = require("./helpers/fake-driver");

const load = (env, options = { envFile: null }) => loadConfig(env, options);
const invalid = fn => assert.throws(fn, error => error.name === "SqlError" && error.kind === "INVALID_PARAMS");
const rejects = (promise, kind) => assert.rejects(promise, error => { assert.equal(error.kind, kind); return true; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- SEC-02
test("SEC-02: URL query parameters can not override ssl or the timeouts of the pg pool", () => {
  let received;
  class FakePool { constructor(options) { received = options; } on() {} }
  const url = "postgresql://us%40er:p%3Fw@db.example:6543/mydb?sslmode=disable&statement_timeout=0&query_timeout=0&options=-c%20x%3D1&host=evil&application_name=x";
  const config = load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: url, MS_SQL_SSL: "true", MS_SQL_QUERY_TIMEOUT_MS: "2500" });
  createPostgresDriver(config, { Pool: FakePool });
  assert.equal("connectionString" in received, false, "pg must not get a connection string to merge");
  assert.equal(received.host, "db.example");
  assert.equal(received.port, 6543);
  assert.equal(received.user, "us@er");
  assert.equal(received.password, "p?w");
  assert.equal(received.database, "mydb");
  assert.deepEqual(received.ssl, { rejectUnauthorized: true });
  assert.equal(received.statement_timeout, 2500);
  assert.equal(received.query_timeout, 3500);
  assert.equal(received.application_name, "MagicSchoolRP-ms-sql");
  assert.equal("options" in received, false);
  assert.deepEqual(config.ignoredUrlParams, ["sslmode", "statement_timeout", "query_timeout", "options", "host", "application_name"]);
});

// ---------------------------------------------------------------- SEC-06
test("SEC-06: MS_SQL_SSL_CA is read at load time and handed to both drivers as ssl.ca", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-sql-ca-"));
  const file = path.join(dir, "ca.pem");
  const pem = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
  fs.writeFileSync(file, pem);
  try {
    let pgOptions, myOptions;
    class FakePool { constructor(options) { pgOptions = options; } on() {} }
    createPostgresDriver(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db", MS_SQL_SSL: "true", MS_SQL_SSL_CA: file }), { Pool: FakePool });
    assert.deepEqual(pgOptions.ssl, { rejectUnauthorized: true, ca: pem });
    const lib = { createPool: options => { myOptions = options; return { pool: { on() {} }, end: async () => {} }; } };
    createMysqlDriver(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@h/db", MS_SQL_SSL: "true", MS_SQL_SSL_CA: file }), { mysql: lib });
    assert.deepEqual(myOptions.ssl, { rejectUnauthorized: true, ca: pem });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SEC-06: invalid MS_SQL_SSL_CA fails without echoing path or content; it needs MS_SQL_SSL=true", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-sql-ca-"));
  const junk = path.join(dir, "secret-name.pem");
  fs.writeFileSync(junk, "TOP-SECRET-CONTENT");
  try {
    for (const file of [junk, path.join(dir, "missing.pem")]) {
      assert.throws(() => load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db", MS_SQL_SSL: "true", MS_SQL_SSL_CA: file }),
        error => /MS_SQL_SSL_CA/.test(error.message) && !error.message.includes("TOP-SECRET") && !error.message.includes(dir));
    }
    assert.throws(() => load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db", MS_SQL_SSL_CA: junk }), /requires MS_SQL_SSL=true/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SEC-06: warns when TLS is off and the host is remote, not for loopback or TLS on; never prints the URL", () => {
  const run = env => {
    const logs = [], handlers = {};
    const host = {
      Events: { on: (name, fn) => { handlers[name] = fn; }, emit() {} }, Exports: { register: () => true },
      console: { log() {}, warn: m => logs.push(m), error: m => logs.push(m) },
    };
    start(host, { loadConfig: () => load(env), createSql: () => ({ close() {} }) });
    handlers.resourceStart("ms-sql");
    return logs;
  };
  const remote = run({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:topsecret@db.example.com/ms_test" });
  assert.equal(remote.length, 1);
  assert.match(remote[0], /MS_SQL_SSL is false/);
  assert.ok(!remote[0].includes("topsecret"));
  assert.deepEqual(run({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@127.0.0.1/ms_test" }), []);
  assert.deepEqual(run({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@[::1]/ms_test" }), []);
  assert.deepEqual(run({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@LOCALHOST/ms_test" }), []);
  assert.deepEqual(run({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@db.example.com/ms_test", MS_SQL_SSL: "true" }), []);
  const ignored = run({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@127.0.0.1/ms_test?sslmode=disable&statement_timeout=0" });
  assert.equal(ignored.length, 1);
  assert.match(ignored[0], /sslmode, statement_timeout/);
});

test("R-01: a URL asking for TLS with MS_SQL_SSL off still starts, warns (names only) on any host", () => {
  const run = env => {
    const logs = [], handlers = {};
    let created = 0;
    const host = {
      Events: { on: (name, fn) => { handlers[name] = fn; }, emit() {} }, Exports: { register: () => true },
      console: { log() {}, warn: m => logs.push(m), error: m => logs.push(m) },
    };
    start(host, { loadConfig: () => load(env), createSql: () => { created++; return { close() {} }; } });
    handlers.resourceStart("ms-sql");
    assert.equal(created, 1, "startup is not refused");
    return logs.filter(m => /requests TLS/.test(m));
  };
  const base = { MS_SQL_SCHEMA: "ms_test" };
  for (const host of ["127.0.0.1", "db.example.com"]) {
    const warned = run({ ...base, MS_SQL_URL: `postgres://u:topsecret@${host}/ms_test?sslmode=require&sslrootcert=/etc/SECRET-ca.pem` });
    assert.equal(warned.length, 1, host);
    assert.match(warned[0], /sslmode, sslrootcert/);
    assert.match(warned[0], /MS_SQL_SSL=true/);
    assert.match(warned[0], /MS_SQL_SSL_CA/);
    for (const leak of ["topsecret", "require", "SECRET-ca", host, "postgres://"]) assert.ok(!warned[0].includes(leak), leak);
  }
  assert.equal(run({ ...base, MS_SQL_URL: "mysql://u:p@127.0.0.1/ms_test?ssl-mode=REQUIRED" }).length, 1);
  assert.equal(run({ ...base, MS_SQL_URL: "mysql://u:p@h/ms_test?ssl=true" }).length, 1);
  assert.equal(run({ ...base, MS_SQL_URL: "postgres://u:p@db.example.com/ms_test?sslmode=verify-full", MS_SQL_SSL: "true" }).length, 0, "MS_SQL_SSL=true: no TLS warning");
  assert.equal(run({ ...base, MS_SQL_URL: "postgres://u:p@127.0.0.1/ms_test" }).length, 0, "no TLS parameters: no warning");
  assert.equal(run({ ...base, MS_SQL_URL: "postgres://u:p@127.0.0.1/ms_test?application_name=x" }).length, 0);
  assert.equal(run({ ...base, MS_SQL_URL: "postgres://u:p@127.0.0.1/ms_test?sslmode=disable" }).length, 0, "explicit sslmode=disable asks for no TLS");
});

// ---------------------------------------------------------------- SEC-07
test("SEC-07: printing a SqlError or its cause never shows driver values", () => {
  const secret = "SENTINEL-secret-value";
  const pgCause = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "uq", detail: `Key (value)=(${secret}) already exists.`, where: secret, parameters: [secret] });
  const myCause = Object.assign(new Error("dup"), { errno: 1062, code: "ER_DUP_ENTRY", sqlState: "23000", sql: `INSERT INTO t VALUES ('${secret}')`, sqlMessage: `Duplicate entry '${secret}' for key 'uq'` });
  for (const [dialect, cause] of [["postgres", pgCause], ["mysql", myCause]]) {
    const error = mapError(dialect, cause);
    assert.equal(error.kind, "UNIQUE_VIOLATION");
    assert.equal(error.cause, cause, "cause stays available to server code");
    for (const text of [util.inspect(error, { depth: 8 }), util.inspect({ wrapper: error }, { depth: 8 }), util.inspect(cause, { depth: 8 }), JSON.stringify(error), JSON.stringify(cause)]) {
      assert.ok(!text.includes(secret), text);
    }
  }
  assert.ok(myCause.sqlMessage.includes(secret), "fields stay readable when accessed explicitly");
});

test("SEC-07: callback and close failures are logged by code or name only", async () => {
  const driver = fakeDriver();
  driver.end = async () => { throw Object.assign(new Error("host 10.0.0.1:5432 refused"), { code: "ECONNREFUSED" }); };
  const logs = [];
  const sql = createSql({ config: load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db" }), driver, backoff: { minMs: 5, maxMs: 20 },
    logger: { info() {}, warn() {}, error: m => logs.push(m) }, onReady() { throw new Error("secret 10.0.0.1"); } });
  await sql.awaitConnection(1000);
  await sql.close();
  assert.ok(logs.length >= 2);
  assert.ok(logs.every(message => !message.includes("10.0.0.1")), logs.join("|"));
});

// ---------------------------------------------------------------- SEC-09
test("SEC-09: config limits have sane defaults, are overridable and validated", () => {
  const config = load({});
  assert.deepEqual([config.maxSqlBytes, config.maxParams, config.maxBatch, config.holdTimeoutMs], [1048576, 65535, 10000, 60000]);
  const custom = load({ MS_SQL_MAX_SQL_BYTES: "2048", MS_SQL_MAX_PARAMS: "10", MS_SQL_MAX_BATCH: "5", MS_SQL_HOLD_TIMEOUT_MS: "2000" });
  assert.deepEqual([custom.maxSqlBytes, custom.maxParams, custom.maxBatch, custom.holdTimeoutMs], [2048, 10, 5, 2000]);
  for (const key of ["MS_SQL_MAX_SQL_BYTES", "MS_SQL_MAX_PARAMS", "MS_SQL_MAX_BATCH", "MS_SQL_HOLD_TIMEOUT_MS"]) {
    assert.throws(() => load({ [key]: "0" }), new RegExp(key));
    assert.throws(() => load({ [key]: "abc" }), new RegExp(key));
  }
});

test("SEC-09: oversized SQL and too many parameters are rejected with INVALID_PARAMS", () => {
  for (const dialect of ["postgres", "mysql", "mariadb"]) {
    invalid(() => translate("SELECT 1 -- " + "x".repeat(1048576), [], dialect));
    invalid(() => translate("SELECT '" + "é".repeat(600000) + "'", [], dialect)); // under 1 MiB in chars, over in bytes
    translate("SELECT '" + "x".repeat(1000000) + "'", [], dialect);
    invalid(() => translate("SELECT ?", new Array(70000).fill(1), dialect));
    invalid(() => translate("SELECT " + "?,".repeat(70000) + "1", new Array(70000).fill(1), dialect));
    invalid(() => translate("SELECT ?, ?, ?", [1, 2, 3], dialect, { maxParams: 2 }));
    invalid(() => translate("SELECT 12345", [], dialect, { maxSqlBytes: 10 }));
  }
});

function sqlWith(t, extra = {}) {
  const driver = fakeDriver();
  const sql = createSql({ config: { ...load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db" }), ...extra }, driver, backoff: { minMs: 5, maxMs: 20 }, logger: { info() {}, warn() {}, error() {} } });
  t.after(() => sql.close());
  return { sql, driver, state: driver.state };
}

test("SEC-09: batches above maxBatch are rejected before touching the database", async t => {
  const { sql, state } = sqlWith(t, { maxBatch: 3 });
  await sql.awaitConnection(1000);
  await rejects(sql.rawExecute("INSERT INTO t VALUES (?)", [[1], [2], [3], [4]]), "INVALID_PARAMS");
  await rejects(sql.transaction([1, 2, 3, 4].map(n => ({ query: "INSERT INTO t VALUES (?)", values: [n] }))), "INVALID_PARAMS");
  assert.equal(state.log.length, 0);
  assert.equal(state.released.length, 0);
  await sql.rawExecute("INSERT INTO t VALUES (?)", [[1], [2], [3]]);
  assert.equal(await sql.transaction([{ query: "INSERT INTO t VALUES (?)", values: [1] }]), true);
});

test("SEC-09: a transaction callback that never settles times out, destroys the connection and frees the pool", async t => {
  const { sql, state } = sqlWith(t, { holdTimeoutMs: 40 });
  await sql.awaitConnection(1000);
  let scope;
  await rejects(sql.transaction(async tx => { scope = tx; await new Promise(() => {}); }), "TIMEOUT");
  assert.deepEqual(state.released, [{ id: 1, broken: true }], "released once, destroyed");
  assert.equal(state.active, 0);
  assert.ok(!labels(state).includes("commit") && !labels(state).includes("rollback"));
  await rejects(scope.query("SELECT 1"), "OTHER"); // the dead scope runs nothing more
  assert.equal(await sql.transaction(async tx => { await tx.query("SELECT 1"); return "ok"; }), "ok"); // pool serves again
});

test("SEC-09: withLock with a hung callback times out, drops the connection and lets the next holder in", async t => {
  const { sql, state } = sqlWith(t, { holdTimeoutMs: 40 });
  await sql.awaitConnection(1000);
  const hung = sql.withLock("job", async () => { await new Promise(() => {}); });
  const next = sql.withLock("job", async () => "second");
  await rejects(hung, "TIMEOUT");
  assert.equal(await next, "second");
  assert.equal(state.released[0].broken, true);
  assert.equal(state.active, 0);
});

test("SEC-09: scopes that finish in time are unaffected by the watchdog", async t => {
  const { sql, state } = sqlWith(t, { holdTimeoutMs: 200 });
  await sql.awaitConnection(1000);
  assert.equal(await sql.transaction(async tx => { await wait(20); await tx.query("SELECT 1"); return 7; }), 7);
  assert.equal(await sql.withLock("quick", async tx => { await tx.query("SELECT 1"); return 8; }), 8);
  await wait(250); // a leaked timer would fire and destroy something now
  assert.ok(state.released.every(entry => entry.broken === false));
});

// ---------------------------------------------------------------- SEC-10
test("SEC-10: executable comments are rejected on MySQL/MariaDB; plain comments and PostgreSQL are unchanged", () => {
  for (const dialect of ["mysql", "mariadb"]) {
    invalid(() => translate("SELECT 'x' /*! ; DROP TABLE x */ , ?", [1], dialect));
    invalid(() => translate("SELECT /*!50000 1 */", [], dialect));
    invalid(() => translate("SELECT /*M! 1 */ 1", [], dialect));
    invalid(() => translate("SELECT 1 /*M!100100 ; DROP TABLE x */", [], dialect));
    assert.equal(translate("SELECT /* plain */ ?", [1], dialect).text, "SELECT /* plain */ ?");
    assert.equal(translate("SELECT /*+ NO_RANGE_OPTIMIZATION(t) */ ?", [1], dialect).values.length, 1);
    assert.equal(translate("SELECT '/*! not a comment */', ?", [1], dialect).values.length, 1); // inside a string literal
  }
  assert.equal(translate("SELECT /*! pg comment */ ?", [1], "postgres").text, "SELECT /*! pg comment */ $1");
});

// ---------------------------------------------------------------- SEC-01
test("SEC-01/R-04: every mysql2 session fixes sql_mode in one statement (risky modes out, STRICT_ALL_TABLES in)", () => {
  let handler;
  const lib = { createPool: () => ({ pool: { on: (_, fn) => { handler = fn; } }, end: async () => {} }) };
  createMysqlDriver(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@h/db" }), { mysql: lib });
  const sent = [];
  handler({ query: (sql, callback) => { sent.push(sql); callback(null, [{ sql_mode: "STRICT_ALL_TABLES" }]); }, destroy() {} });
  const statements = sent.filter(sql => /^SET SESSION sql_mode/.test(sql));
  assert.equal(statements.length, 1, "a single sql_mode statement");
  const statement = statements[0];
  assert.match(statement, /REPLACE\(REPLACE\(CONCAT\(',', @@sql_mode, ','\)/);
  assert.ok(statement.includes("'STRICT_ALL_TABLES'"));
  // Same algorithm as the SQL expression, to prove separators are handled for every position of the token.
  const apply = mode => {
    const del = (text, token) => text.split(`,${token},`).join(",");
    const cleaned = del(del(`,${mode},`, "NO_BACKSLASH_ESCAPES"), "ANSI_QUOTES").replace(/^,+|,+$/g, "");
    const hasStrict = mode.split(",").includes("STRICT_ALL_TABLES");
    return [cleaned || null, hasStrict ? null : "STRICT_ALL_TABLES"].filter(Boolean).join(",");
  };
  assert.equal(apply("ANSI_QUOTES,NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES"), "STRICT_TRANS_TABLES,STRICT_ALL_TABLES");
  assert.equal(apply("NO_BACKSLASH_ESCAPES,ANSI_QUOTES"), "STRICT_ALL_TABLES");
  assert.equal(apply(""), "STRICT_ALL_TABLES", "empty server mode");
  assert.equal(apply("ONLY_FULL_GROUP_BY,NO_BACKSLASH_ESCAPES"), "ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES");
  assert.equal(apply("ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES"), "ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES", "no duplication");
  // A failed confirmation destroys the connection (fail closed).
  let destroyed = 0;
  handler({ query: (sql, callback) => callback(null, /^SELECT @@SESSION/.test(sql) ? [{ sql_mode: "NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES" }] : undefined), destroy() { destroyed++; } });
  assert.equal(destroyed, 1);
});
