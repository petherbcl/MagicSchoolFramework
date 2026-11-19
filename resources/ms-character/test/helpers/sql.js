"use strict";

// Test database targets for ms-character, one per SQL dialect (same approach as ms-core/test/helpers/sql.js).
// PostgreSQL runs in-process on PGlite exposed over a TCP socket, so the real `pg` driver and the real ms-sql
// `createSql` are exercised. MySQL and MariaDB need a real server, supplied through MS_SQL_TEST_MYSQL_URL /
// MS_SQL_TEST_MARIADB_URL; without them the dialect is skipped with a visible reason. ms-character itself never
// imports a database driver. ms-character needs ms-core's tables first (same schema), so startDb creates them.

const { loadConfig } = require("../../../ms-sql/server/config");
const { createSql } = require("../../../ms-sql/server");
const { schemaFor: coreSchemaFor } = require("../../../ms-core/server/database/schema");

const TEST_SCHEMA = "ms_test"; // created by ms-sql at startup; neither ms-core nor ms-character name it
const EXTERNAL = { mysql: "MS_SQL_TEST_MYSQL_URL", mariadb: "MS_SQL_TEST_MARIADB_URL" };
const CORE_TABLES = ["ms_audit_log", "ms_bans", "ms_character_roles", "ms_connection_identifiers", "ms_sessions", "ms_user_credentials", "ms_users"];

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

// Starts the target, creates ms-core's tables and returns the real ms-sql API plus per-dialect helpers.
// ms-character's own schema is created by the Repository under test. Call `stop()` when finished.
async function startDb(target) {
  const server = await target.start();
  const owned = [];
  const sql = newSql(server.url); owned.push(sql);
  await sql.awaitConnection(10000);
  const mysqlFamily = target.name !== "postgres";
  for (const statement of coreSchemaFor(sql.dialect)) await sql.query(statement);
  return {
    name: target.name, sql,
    // An independent ms-sql instance (separate pool), e.g. to simulate an ms-sql reload.
    async another() { const extra = newSql(server.url); owned.push(extra); await extra.awaitConnection(10000); return extra; },
    // Empties ms-character and ms-core tables and restarts the identities. Requires ms-character's schema to exist.
    async resetTables() {
      if (!mysqlFamily) { await sql.query("TRUNCATE ms_characters, ms_users RESTART IDENTITY CASCADE"); return; }
      // FOREIGN_KEY_CHECKS is per connection: run everything on one dedicated connection.
      await sql.withLock("test-reset", async tx => {
        await tx.query("SET FOREIGN_KEY_CHECKS=0");
        try {
          await tx.query("TRUNCATE TABLE ms_characters");
          for (const table of CORE_TABLES) await tx.query(`TRUNCATE TABLE ${table}`);
        } finally { await tx.query("SET FOREIGN_KEY_CHECKS=1"); }
      });
    },
    // Creates `count` pending accounts (ids 1..count after a reset).
    async seedUsers(count) {
      for (let i = 0; i < count; i++) await sql.query("INSERT INTO ms_users(allowlist,metadata) VALUES(?,?)", ["pending", "{}"]);
    },
    schema: TEST_SCHEMA,
    // Condition that selects the current schema in information_schema.
    currentSchema: mysqlFamily ? "DATABASE()" : "current_schema()",
    // Drops ms-character's table (ms-core's tables stay) so the DDL can be re-run from nothing.
    async dropCharacterTables() { await sql.query("DROP TABLE IF EXISTS ms_characters"); },
    async stop() {
      for (const item of owned) await item.close();
      await server.stop();
    },
  };
}

module.exports = { DIALECTS, describeDialect, startDb, TEST_SCHEMA };
