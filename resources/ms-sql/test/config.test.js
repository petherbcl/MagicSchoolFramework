"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../server/config");

const load = (env, options = { envFile: null }) => loadConfig(env, options);

test("no URL means databaseConfigured false and defaults", () => {
  const config = load({});
  assert.equal(config.databaseConfigured, false);
  assert.equal(config.dialect, null);
  assert.equal(config.url, "");
  assert.equal(config.poolSize, 5);
  assert.equal(config.queryTimeoutMs, 10000);
  assert.equal(config.slowQueryMs, 1000);
  assert.equal(config.ssl, false);
});

test("dialect is deduced from the URL protocol", () => {
  assert.equal(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db" }).dialect, "postgres");
  assert.equal(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgresql://u:p@h:5432/db" }).dialect, "postgres");
  assert.equal(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@h:3306/db" }).dialect, "mysql");
  assert.equal(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mariadb://u:p@h:3306/db" }).dialect, "mariadb");
  assert.equal(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "MySQL://u:p@h/db" }).dialect, "mysql");
  assert.equal(load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "mysql://u:p@h/db" }).databaseConfigured, true);
});

test("invalid or foreign URLs throw the documented error without leaking the secret", () => {
  for (const url of ["http://u:topsecret@h/db", "mongodb://u:topsecret@h/db", "u:topsecret@h/db", "mysql2://u:topsecret@h/db",
    "postgres://u:topsecret@h:99999999/db", "mysql://u:topsecret@[bad/db"]) {
    assert.throws(() => load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: url }), error => {
      assert.equal(error.message, "MS_SQL_URL must be a PostgreSQL, MySQL or MariaDB connection string");
      assert.ok(!error.message.includes("topsecret"));
      return true;
    }, url);
  }
});

test("numeric options are bounded", () => {
  assert.equal(load({ MS_SQL_POOL_SIZE: "1" }).poolSize, 1);
  assert.equal(load({ MS_SQL_POOL_SIZE: "20" }).poolSize, 20);
  for (const [key, value] of [["MS_SQL_POOL_SIZE", "0"], ["MS_SQL_POOL_SIZE", "21"], ["MS_SQL_POOL_SIZE", "abc"], ["MS_SQL_POOL_SIZE", "2.5"],
    ["MS_SQL_QUERY_TIMEOUT_MS", "10"], ["MS_SQL_QUERY_TIMEOUT_MS", "-1"], ["MS_SQL_SLOW_QUERY_MS", "-1"], ["MS_SQL_SLOW_QUERY_MS", "x"]]) {
    assert.throws(() => load({ [key]: value }), new RegExp("^Error: Invalid " + key + "$"), key + "=" + value);
  }
  assert.equal(load({ MS_SQL_SLOW_QUERY_MS: "0" }).slowQueryMs, 0);
});

test("MS_SQL_SSL accepts only true or false", () => {
  assert.equal(load({ MS_SQL_SSL: "true" }).ssl, true);
  assert.equal(load({ MS_SQL_SSL: "FALSE" }).ssl, false);
  assert.throws(() => load({ MS_SQL_SSL: "yes" }), /Invalid MS_SQL_SSL/);
});

test("the config object is frozen", () => {
  const config = load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db" });
  assert.ok(Object.isFrozen(config));
  assert.throws(() => { "use strict"; config.poolSize = 9; }, TypeError);
});

test("the .env file is read, and explicit env values win over it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-sql-config-"));
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "﻿MS_SQL_SCHEMA=env_schema\nMS_SQL_URL=mariadb://u:p@h/db\nMS_SQL_POOL_SIZE=7\n");
    const config = loadConfig({ MS_SQL_POOL_SIZE: "3" }, { envFile: file });
    assert.equal(config.dialect, "mariadb");
    assert.equal(config.poolSize, 3);
    assert.equal(loadConfig({}, { envFile: path.join(dir, "missing.env") }).databaseConfigured, false);
    assert.throws(() => loadConfig({}, { envFile: dir }), /MS_SQL_ENV_FILE_UNREADABLE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("process.env is not mutated", () => {
  const before = JSON.stringify(process.env);
  load({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db" });
  assert.equal(JSON.stringify(process.env), before);
});

test("MS_SQL_SCHEMA is required with a URL and strictly validated", () => {
  const url = "postgres://u:topsecret@h/db";
  assert.equal(load({ MS_SQL_URL: url, MS_SQL_SCHEMA: "magic_school_rp" }).schema, "magic_school_rp");
  assert.equal(load({ MS_SQL_URL: url, MS_SQL_SCHEMA: " _x1 " }).schema, "_x1");
  assert.equal(load({}).schema, "", "no URL: nothing to validate");
  const bad = ["", "1abc", "a-b", "a b", "a;DROP", 'a"b', "a`b", "a.b", "x".repeat(64), "pg_catalog", "PG_temp", "information_schema", "mysql", "sys", "performance_schema"];
  for (const schema of bad) {
    assert.throws(() => load({ MS_SQL_URL: url, ...(schema === "" ? {} : { MS_SQL_SCHEMA: schema }) }), error => {
      assert.match(error.message, /^Invalid MS_SQL_SCHEMA/);
      assert.ok(!error.message.includes("topsecret") && (schema.length < 4 || !error.message.includes(schema.trim())));
      return true;
    }, JSON.stringify(schema));
  }
  assert.equal(load({ MS_SQL_URL: "mysql://u:p@h/db", MS_SQL_SCHEMA: "magic" }).ignoredUrlDatabase, true);
  assert.equal(load({ MS_SQL_URL: "mysql://u:p@h/magic", MS_SQL_SCHEMA: "magic" }).ignoredUrlDatabase, false);
  assert.equal(load({ MS_SQL_URL: "mysql://u:p@h", MS_SQL_SCHEMA: "magic" }).ignoredUrlDatabase, false);
  assert.equal(load({ MS_SQL_URL: "postgres://u:p@h/db", MS_SQL_SCHEMA: "magic" }).ignoredUrlDatabase, false, "PostgreSQL: the URL path is the cluster database");
});
