"use strict";
const { Pool } = require("pg");
const schema = require("./schema");
const { check, json, characterInput, publicId } = require("../validation");

class Repository {
  constructor(config, { pool } = {}) {
    this.pool = pool || new Pool({ connectionString: config.databaseUrl, max: config.poolSize,
      connectionTimeoutMillis: config.queryTimeoutMs, statement_timeout: config.queryTimeoutMs,
      idleTimeoutMillis: 10000, application_name: "MagicSchoolRP-ms-character" });
    this.pool.on?.("error", () => {});
  }
  async transaction(fn) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async createSchema() {
    await this.transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(684331906)");
      check((await db.query("SELECT to_regclass('ms_core.ms_users') AS t")).rows[0].t, "MS_CORE_SCHEMA_MISSING");
      await db.query(schema);
    });
  }
  map(row) {
    return row ? { characterId: String(row.id), userId: String(row.user_id), firstName: row.first_name, lastName: row.last_name,
      house: row.house, state: row.state, version: row.version } : null;
  }
  async get(id) { return this.map((await this.pool.query("SELECT * FROM ms_character.characters WHERE id=$1", [publicId(id)])).rows[0]); }
  // Most recently played first, so the lobby can highlight the last character.
  async list(userId) {
    return (await this.pool.query("SELECT * FROM ms_character.characters WHERE user_id=$1 ORDER BY last_played_at DESC NULLS LAST, id",
      [publicId(userId)])).rows.map(row => this.map(row));
  }
  async create(userId, input, maxCharacters) {
    const value = characterInput(input);
    return this.transaction(async db => {
      // Locking the account row serialises concurrent creations against the limit.
      check((await db.query("SELECT id FROM ms_core.ms_users WHERE id=$1 FOR UPDATE", [publicId(userId)])).rowCount, "USER_NOT_FOUND");
      check(Number((await db.query("SELECT count(*) AS n FROM ms_character.characters WHERE user_id=$1", [userId])).rows[0].n) < maxCharacters, "CHARACTER_LIMIT");
      const row = (await db.query("INSERT INTO ms_character.characters(user_id,first_name,last_name,house) VALUES($1,$2,$3,$4) RETURNING *",
        [userId, value.firstName, value.lastName, value.house])).rows[0];
      await db.query("INSERT INTO ms_core.ms_audit_log(actor,action,user_id,details) VALUES($1,'character.created',$2,$3)",
        ["user:" + userId, userId, JSON.stringify({ characterId: String(row.id) })]);
      return this.map(row);
    });
  }
  async touch(id) { await this.pool.query("UPDATE ms_character.characters SET last_played_at=now() WHERE id=$1", [publicId(id)]); }
  async save(id, userId, expectedVersion, state) {
    const result = await this.pool.query(`UPDATE ms_character.characters SET state=$1,version=version+1,updated_at=now()
      WHERE id=$2 AND user_id=$3 AND version=$4 RETURNING *`, [json(state, 2 * 1024 * 1024), publicId(id), publicId(userId), expectedVersion]);
    check(result.rowCount === 1, "REVISION_CONFLICT"); return this.map(result.rows[0]);
  }
  async close() { if (!this.closed) { this.closed = true; await this.pool.end(); } }
}
module.exports = { Repository };
