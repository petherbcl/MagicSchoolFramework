"use strict";

// Per-dialect test targets. PostgreSQL runs in-process on PGlite exposed over a TCP socket, so the real
// `pg` driver is exercised. MySQL and MariaDB need a real server, supplied through environment variables;
// without them the dialect is reported as skipped with a visible reason.

const { loadConfig } = require("../../server/config");
const { createSql } = require("../../server");

const EXTERNAL = {
  mysql: "MS_SQL_TEST_MYSQL_URL",
  mariadb: "MS_SQL_TEST_MARIADB_URL",
};

async function startPostgres() {
  const { PGlite } = require("@electric-sql/pglite");
  const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 16 });
  await server.start();
  return {
    url: "postgresql://postgres:postgres@" + server.getServerConn() + "/postgres",
    async stop() { await server.stop(); await engine.close(); },
  };
}

// Returns { name, skip, start() }. `skip` is a string (the reason) when the dialect is unavailable.
function describeDialect(name, env = process.env) {
  if (name === "postgres") return { name, skip: false, start: startPostgres };
  const variable = EXTERNAL[name];
  const url = env[variable];
  if (!url) return { name, skip: `${variable} is not set`, start: null };
  return { name, skip: false, start: async () => ({ url, async stop() {} }) };
}

const DIALECTS = ["postgres", "mysql", "mariadb"].map(name => describeDialect(name));

// Builds the real createSql against a started target. `overrides` are merged into the env-style config.
function connect(target, overrides = {}, options = {}) {
  const config = loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: target.url, MS_SQL_POOL_SIZE: "4", MS_SQL_SLOW_QUERY_MS: "0", ...overrides }, { envFile: null });
  const warnings = [];
  const sql = createSql({ config, logger: { info() {}, warn: m => warnings.push(m), error: m => warnings.push(m) }, ...options });
  return { sql, config, warnings };
}

// Minimal DDL used by the API tests, per dialect (the full portable schemas live in ms-core/ms-character).
const DDL = {
  postgres: {
    create: "CREATE TABLE IF NOT EXISTS t_items (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL UNIQUE, qty INTEGER NOT NULL DEFAULT 0, data JSONB, created TIMESTAMPTZ DEFAULT now())",
    createChild: "CREATE TABLE IF NOT EXISTS t_children (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, item_id BIGINT NOT NULL REFERENCES t_items(id))",
    reset: ["TRUNCATE t_children, t_items RESTART IDENTITY CASCADE"],
  },
  mysql: {
    create: "CREATE TABLE IF NOT EXISTS t_items (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) COLLATE utf8mb4_bin NOT NULL UNIQUE, qty INT NOT NULL DEFAULT 0, data JSON, created DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB",
    createChild: "CREATE TABLE IF NOT EXISTS t_children (id BIGINT AUTO_INCREMENT PRIMARY KEY, item_id BIGINT NOT NULL, CONSTRAINT fk_child_item FOREIGN KEY (item_id) REFERENCES t_items(id)) ENGINE=InnoDB",
    reset: ["SET FOREIGN_KEY_CHECKS=0", "TRUNCATE t_children", "TRUNCATE t_items", "SET FOREIGN_KEY_CHECKS=1"],
  },
};
DDL.mariadb = DDL.mysql;

module.exports = { DIALECTS, describeDialect, connect, DDL };
