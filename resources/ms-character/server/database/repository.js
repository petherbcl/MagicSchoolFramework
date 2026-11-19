"use strict";
const { schemaFor } = require("./schema");
const { check, json, characterInput, lookInput, publicId } = require("../validation");

const SCHEMA_LOCK = "ms-character:schema";
const MAX_DEADLOCK_RETRIES = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
// CURRENT_TIMESTAMP(3) is valid on PostgreSQL, MySQL and MariaDB and matches the DATETIME(3) columns.
const NOW = "CURRENT_TIMESTAMP(3)";

// All SQL is portable (`?` placeholders, no dialect branches). `sql` is the ms-sql API (or a function that
// returns it, so a reloaded ms-sql export is never stale). `db` arguments are either `sql` or a transaction.
// `clock` only computes the cutoffs of the 24 h creation cap and of the retention purge (passed as Date
// parameters); every stored timestamp comes from the database clock.
class Repository {
  constructor(sql, { clock = Date.now } = {}) { this.source = sql; this.clock = clock; }
  get sql() {
    const sql = typeof this.source === "function" ? this.source() : this.source;
    // While ms-sql is stopped the runtime has removed its export: fail with a coded error, not a TypeError.
    if (!sql) throw Object.assign(new Error("ms-sql export is unavailable"), { code: "SQL_UNAVAILABLE", kind: "NOT_READY" });
    return sql;
  }
  async transaction(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.sql.transaction(fn); }
      catch (error) {
        // MySQL/MariaDB may pick a transaction as deadlock victim; everything inside is rolled back, so replay it.
        if (error?.kind === "DEADLOCK" && attempt < MAX_DEADLOCK_RETRIES) continue;
        throw error;
      }
    }
  }
  async createTables() {
    const statements = schemaFor(this.sql.dialect);
    // DDL is not transactional on MySQL/MariaDB, so the application lock (not a transaction) is the common mechanism.
    await this.sql.withLock(SCHEMA_LOCK, async db => {
      // ms-core's tables live in the same schema, the one ms-sql bound this connection to (no schema name here).
      const current = this.sql.dialect === "postgres" ? "current_schema()" : "DATABASE()";
      check(await db.single(`SELECT 1 AS present FROM information_schema.tables WHERE table_schema=${current} AND table_name='ms_users'`), "MS_CORE_SCHEMA_MISSING");
      for (const statement of statements) await db.query(statement);
    });
  }
  map(row) {
    return row ? { characterId: String(row.id), userId: String(row.user_id), firstName: row.first_name, lastName: row.last_name,
      house: row.house, state: row.state, version: row.version, lastPlayedAt: row.last_played_at ? row.last_played_at.toISOString() : null } : null;
  }
  // Soft-deleted characters are hidden unless explicitly requested (no current caller does).
  async get(id, { includeDeleted = false } = {}) {
    return this.map(await this.sql.single(`SELECT * FROM ms_characters WHERE id=?${includeDeleted === true ? "" : " AND deleted_at IS NULL"}`, [publicId(id)]));
  }
  // Active characters only, most recently played first, so the lobby can highlight the last character.
  // (col IS NULL) sorts never-played characters last without NULLS LAST, which MySQL lacks.
  async list(userId) {
    return (await this.sql.query("SELECT * FROM ms_characters WHERE user_id=? AND deleted_at IS NULL ORDER BY (last_played_at IS NULL), last_played_at DESC, id",
      [publicId(userId)])).map(row => this.map(row));
  }
  async create(userId, input, maxCharacters, maxCreationsPerDay = 5) {
    const value = characterInput(input);
    // Name/house errors win over look errors; the look is validated and sanitised before any DB work.
    const state = { inventory: [], look: lookInput(input.look, value), location: null };
    const encoded = json(state, 2 * 1024 * 1024);
    return this.transaction(async db => {
      // Locking the account row serialises concurrent creations against the limit.
      check(await db.single("SELECT id FROM ms_users WHERE id=? FOR UPDATE", [publicId(userId)]), "USER_NOT_FOUND");
      // Cap on creations in 24 h, deleted ones included: a create/delete loop must not grow the table (M-01).
      const since = new Date(this.clock() - DAY_MS);
      check(Number(await db.scalar("SELECT count(*) FROM ms_characters WHERE user_id=? AND created_at > ?", [userId, since])) < maxCreationsPerDay, "CREATE_COOLDOWN");
      check(Number(await db.scalar("SELECT count(*) FROM ms_characters WHERE user_id=? AND deleted_at IS NULL", [userId])) < maxCharacters, "CHARACTER_LIMIT");
      const id = await db.insert("INSERT INTO ms_characters(user_id,first_name,last_name,house,state) VALUES(?,?,?,?,?)",
        [userId, value.firstName, value.lastName, value.house, encoded]);
      const row = await db.single("SELECT * FROM ms_characters WHERE id=?", [id]);
      await db.query("INSERT INTO ms_audit_log(actor,action,user_id,details) VALUES(?,?,?,?)",
        ["user:" + userId, "character.created", userId, JSON.stringify({ characterId: String(row.id) })]);
      return this.map(row);
    });
  }
  async touch(id, userId) {
    await this.sql.update(`UPDATE ms_characters SET last_played_at=${NOW} WHERE id=? AND user_id=? AND deleted_at IS NULL`, [publicId(id), publicId(userId)]);
  }
  async save(id, userId, expectedVersion, state) {
    const characterId = publicId(id), encoded = json(state, 2 * 1024 * 1024);
    return this.transaction(async db => {
      const changed = await db.update(`UPDATE ms_characters SET state=?,version=version+1,updated_at=${NOW}
        WHERE id=? AND user_id=? AND version=? AND deleted_at IS NULL`, [encoded, characterId, publicId(userId), expectedVersion]);
      check(changed === 1, "REVISION_CONFLICT");
      return this.map(await db.single("SELECT * FROM ms_characters WHERE id=?", [characterId]));
    });
  }
  // Soft delete by the owner only; the audit row is written in the same transaction.
  async delete(id, userId) {
    const characterId = publicId(id), owner = publicId(userId);
    await this.transaction(async db => {
      const changed = await db.update(`UPDATE ms_characters SET deleted_at=${NOW} WHERE id=? AND user_id=? AND deleted_at IS NULL`,
        [characterId, owner]);
      check(changed === 1, "CHARACTER_NOT_FOUND");
      await db.query("INSERT INTO ms_audit_log(actor,action,user_id,details) VALUES(?,?,?,?)",
        ["user:" + owner, "character.deleted", owner, JSON.stringify({ characterId })]);
    });
  }
  // Trace of a refused ownership check (L-06): someone probing character IDs of other accounts.
  async audit(action, userId, details) {
    await this.sql.query("INSERT INTO ms_audit_log(actor,action,user_id,details) VALUES(?,?,?,?)",
      ["user:" + publicId(userId), action, publicId(userId), JSON.stringify(details)]);
  }
  // Retention (M-01): removes characters deleted more than `days` days ago. Returns how many.
  async purgeDeleted(days) {
    return this.sql.update("DELETE FROM ms_characters WHERE deleted_at IS NOT NULL AND deleted_at < ?", [new Date(this.clock() - days * DAY_MS)]);
  }
}
module.exports = { Repository };
