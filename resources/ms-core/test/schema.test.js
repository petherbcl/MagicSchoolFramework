"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Repository } = require("../server/database/repository");
const { DIALECTS, startDb } = require("./helpers/sql");

for (const target of DIALECTS) describe(target.name, { skip: target.skip }, () => {
  let db, sql, repository;
  const mysqlFamily = target.name !== "postgres";
  before(async () => { db = await startDb(target); sql = db.sql; repository = new Repository(sql); });
  after(async () => { await db?.stop(); });
  beforeEach(async () => { await db.dropTables(); });

  test("schema uses numeric identities only", async () => {
    await repository.createTables();
    const rows = await sql.query(`SELECT table_name AS t,column_name AS c,data_type AS d,${mysqlFamily ? "extra" : "is_identity"} AS e FROM information_schema.columns
      WHERE table_schema=${db.currentSchema} AND column_name='id' ORDER BY table_name`);
    assert.deepEqual(rows.map(r => r.t.toLowerCase()), ["ms_audit_log", "ms_bans", "ms_sessions", "ms_users"]);
    for (const row of rows) {
      assert.equal(row.d.toLowerCase(), "bigint");
      if (mysqlFamily) assert.match(String(row.e), /auto_increment/i); else assert.equal(row.e, "YES");
    }
    assert.equal((await sql.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=${db.currentSchema} AND data_type='uuid'`)).length, 0);
  });
  test("creating the schema again keeps existing data", async () => {
    await repository.createTables();
    await repository.createUser(sql);
    await repository.createTables();
    assert.equal((await sql.query("SELECT id FROM ms_users"))[0].id, "1");
  });
  test("the unique owner index rejects a repeated account identifier but allows repeated IPs", async () => {
    await repository.createTables();
    const a = await repository.createUser(sql), b = await repository.createUser(sql);
    const add = (user, kind, value) => sql.query("INSERT INTO ms_connection_identifiers(user_id,kind,value) VALUES(?,?,?)", [user, kind, value]);
    await add(a, "steamId", "steam-1");
    await assert.rejects(add(b, "steamId", "steam-1"), { kind: "UNIQUE_VIOLATION", constraint: "ms_connection_identifiers_unique_owner" });
    await add(a, "ip", "127.0.0.1"); await add(b, "ip", "127.0.0.1");
    assert.equal((await sql.query("SELECT 1 FROM ms_connection_identifiers WHERE kind='ip'")).length, 2);
  });
  test("credential hashes are compared case-sensitively", async () => {
    await repository.createTables();
    const user = await repository.createUser(sql);
    await sql.query("INSERT INTO ms_user_credentials(token_hash,user_id) VALUES(?,?)", ["AbC", user]);
    await sql.query("INSERT INTO ms_user_credentials(token_hash,user_id) VALUES(?,?)", ["abc", user]);
    assert.equal(await repository.verifyCredential("AbC", user), true);
    assert.equal(await repository.verifyCredential("ABC", user), false);
  });
  test("tables are created unqualified inside the schema configured in ms-sql", async () => {
    await repository.createTables();
    assert.equal(sql.schema, db.schema);
    const rows = await sql.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema=${db.currentSchema} ORDER BY table_name`);
    assert.deepEqual(rows.map(r => r.t.toLowerCase()), ["ms_audit_log", "ms_bans", "ms_character_roles", "ms_connection_identifiers", "ms_sessions", "ms_user_credentials", "ms_users"]);
    assert.equal(await sql.scalar(mysqlFamily ? "SELECT DATABASE()" : "SELECT current_schema()"), db.schema);
  });
});

test("the DDL never creates or names a schema", () => {
  const { schemaFor } = require("../server/database/schema");
  for (const dialect of ["postgres", "mysql", "mariadb"]) {
    const ddl = schemaFor(dialect).join("\n");
    assert.doesNotMatch(ddl, /CREATE\s+(SCHEMA|DATABASE)/i, dialect);
    assert.doesNotMatch(ddl, /ms_core/i, dialect);
    assert.doesNotMatch(ddl, /REFERENCES\s+\w+\./i, dialect);
  }
});
