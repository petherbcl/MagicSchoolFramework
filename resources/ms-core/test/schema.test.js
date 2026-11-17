"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
const { Repository } = require("../server/database/repository");
let engine, server, repository;
before(async () => {
  engine = await PGlite.create();
  server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 4 });
  await server.start();
  repository = new Repository({ databaseUrl: "postgresql://postgres:postgres@" + server.getServerConn() + "/postgres", poolSize: 1, queryTimeoutMs: 10000 });
});
after(async () => { await repository?.close(); await server?.stop(); await engine?.close(); });
beforeEach(async () => { await repository.pool.query("DROP SCHEMA IF EXISTS ms_core CASCADE"); });

test("schema uses numeric identities only", async () => {
  await repository.createSchema();
  const result = await repository.pool.query(`SELECT table_name,column_name,data_type,is_identity FROM information_schema.columns
    WHERE table_schema='ms_core' AND column_name='id' ORDER BY table_name`);
  assert.deepEqual(result.rows.map(r => r.table_name), ["ms_audit_log", "ms_bans", "ms_sessions", "ms_users"]);
  for (const row of result.rows) { assert.equal(row.data_type, "bigint"); assert.equal(row.is_identity, "YES"); }
  assert.equal((await repository.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='ms_core' AND udt_name='uuid'")).rowCount, 0);
});
test("creating the schema again keeps existing data", async () => {
  await repository.createSchema();
  await repository.pool.query("INSERT INTO ms_core.ms_users DEFAULT VALUES");
  await repository.createSchema();
  assert.equal((await repository.pool.query("SELECT id::text FROM ms_core.ms_users")).rows[0].id, "1");
});
