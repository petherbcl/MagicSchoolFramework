"use strict";

// Test database targets for ms-core, one per SQL dialect. PostgreSQL runs in-process on PGlite exposed over a
// TCP socket, so the real `pg` driver and the real ms-sql `createSql` are exercised. MySQL and MariaDB need a
// real server, supplied through MS_SQL_TEST_MYSQL_URL / MS_SQL_TEST_MARIADB_URL; without them the dialect is
// skipped with a visible reason. ms-core itself never imports a database driver.

const { loadConfig } = require("../../../ms-sql/server/config");
const { createSql } = require("../../../ms-sql/server");

const EXTERNAL = { mysql: "MS_SQL_TEST_MYSQL_URL", mariadb: "MS_SQL_TEST_MARIADB_URL" };
const TABLES = ["ms_audit_log", "ms_bans", "ms_character_roles", "ms_connection_identifiers", "ms_sessions", "ms_user_credentials", "ms_users"];
const TEST_SCHEMA = "ms_test"; // created by ms-sql at startup; ms-core only creates tables
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

async function startPostgres() {
  const { PGlite } = require("@electric-sql/pglite");
  const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 16 });
  await server.start();
  return { url: "postgresql://postgres:postgres@" + server.getServerConn() + "/postgres",
    async stop() { await server.stop(); await engine.close(); } };
}

function describeDialect(name, env = process.env) {
  if (name === "postgres") return { name, skip: false, start: startPostgres };
  const variable = EXTERNAL[name], url = env[variable];
  if (!url) return { name, skip: `${variable} is not set`, start: null };
  return { name, skip: false, start: async () => ({ url, async stop() {} }) };
}

// { name, skip, start }: `skip` is a string with the reason when the dialect is unavailable.
const DIALECTS = ["postgres", "mysql", "mariadb"].map(name => describeDialect(name));

function newSql(url, poolSize = 4) {
  const config = loadConfig({ MS_SQL_SCHEMA: TEST_SCHEMA, MS_SQL_URL: url, MS_SQL_POOL_SIZE: String(poolSize), MS_SQL_SLOW_QUERY_MS: "0" }, { envFile: null });
  return createSql({ config, logger: { info() {}, warn() {}, error() {} } });
}

// Starts the target and returns the real ms-sql API plus per-dialect helpers. Call `stop()` when finished.
async function startDb(target) {
  const server = await target.start();
  const owned = [];
  const open = (poolSize) => { const sql = newSql(server.url, poolSize); owned.push(sql); return sql; };
  const sql = open(4);
  await sql.awaitConnection(10000);
  const mysqlFamily = target.name !== "postgres";
  return {
    name: target.name, sql,
    // An independent pool (separate connections), e.g. to simulate a second server process.
    async another(poolSize = 2) { const extra = open(poolSize); await extra.awaitConnection(10000); return extra; },
    // Empties every ms-core table and restarts the identities. Requires the schema to exist.
    async resetTables() {
      if (!mysqlFamily) { await sql.query("TRUNCATE ms_users RESTART IDENTITY CASCADE"); return; }
      // FOREIGN_KEY_CHECKS is per connection: run everything on one dedicated connection.
      await sql.withLock("test-reset", async tx => {
        await tx.query("SET FOREIGN_KEY_CHECKS=0");
        try { for (const table of TABLES) await tx.query(`TRUNCATE TABLE ${table}`); }
        finally { await tx.query("SET FOREIGN_KEY_CHECKS=1"); }
      });
    },
    // Makes the next generated id of `table` equal to `value` (decimal string or number).
    async setNextId(table, value) {
      if (!TABLES.includes(table)) throw new Error("Unknown table");
      const next = BigInt(value).toString();
      await sql.query(mysqlFamily ? `ALTER TABLE ${table} AUTO_INCREMENT = ${next}` : `ALTER TABLE ${table} ALTER COLUMN id RESTART WITH ${next}`);
    },
    // Drops every ms-core table of the test schema (the schema itself belongs to ms-sql and stays).
    async dropTables() {
      await sql.withLock("test-reset", async tx => {
        if (mysqlFamily) await tx.query("SET FOREIGN_KEY_CHECKS=0");
        try { for (const table of TABLES) await tx.query(`DROP TABLE IF EXISTS ${table}${mysqlFamily ? "" : " CASCADE"}`); }
        finally { if (mysqlFamily) await tx.query("SET FOREIGN_KEY_CHECKS=1"); }
      });
    },
    schema: TEST_SCHEMA,
    // Condition that selects the current schema in information_schema.
    currentSchema: mysqlFamily ? "DATABASE()" : "current_schema()",
    async stop() {
      for (const item of owned) await item.close();
      await server.stop();
    },
  };
}

module.exports = { DIALECTS, describeDialect, startDb, TABLES, TEST_SCHEMA };
