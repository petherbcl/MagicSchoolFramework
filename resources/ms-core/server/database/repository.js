"use strict";
const { schemaFor } = require("./schema");
const { check, json, publicId, CoreError, observed, UNIQUE_IDENTIFIERS } = require("../validation");

const OWNER_INDEX = "ms_connection_identifiers_unique_owner";
const SCHEMA_LOCK = "ms-core:schema";
const MAX_DEADLOCK_RETRIES = 2;
// CURRENT_TIMESTAMP(3) is valid on PostgreSQL, MySQL and MariaDB and matches the DATETIME(3) columns.
const NOW = "CURRENT_TIMESTAMP(3)";

// All SQL is portable (`?` placeholders, no dialect branches). `sql` is the ms-sql API (or a function that
// returns it, so a reloaded ms-sql export is never stale). `db` arguments are either `sql` or a transaction.
class Repository {
  constructor(sql) { this.source = sql; }
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
        if (error?.kind === "UNIQUE_VIOLATION" && error.constraint === OWNER_INDEX) throw new CoreError("IDENTIFIER_ALREADY_REGISTERED");
        // MySQL/MariaDB may pick a transaction as deadlock victim; everything inside is rolled back, so replay it.
        if (error?.kind === "DEADLOCK" && attempt < MAX_DEADLOCK_RETRIES) continue;
        throw error;
      }
    }
  }
  async createTables() {
    const statements = schemaFor(this.sql.dialect);
    // Concurrent CREATE ... IF NOT EXISTS (server + admin tool) can still collide without the lock.
    // DDL is not transactional on MySQL/MariaDB, so the lock (not a transaction) is the common mechanism.
    await this.sql.withLock(SCHEMA_LOCK, async db => { for (const statement of statements) await db.query(statement); });
  }
  async audit(db, actor, action, userId, details = {}) {
    await db.query("INSERT INTO ms_audit_log(actor,action,user_id,details) VALUES(?,?,?,?)", [actor, action, userId, json(details)]);
  }
  async getUser(id, db = this.sql) {
    const row = await db.single("SELECT * FROM ms_users WHERE id=?", [publicId(id)]);
    if (!row) return null;
    return { userId: String(row.id), allowlist: row.allowlist, metadata: row.metadata, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
  }
  // Roles are per character. Every character is implicitly "player"; only extra roles are stored.
  async characterRoles(characterId, db = this.sql) {
    const rows = await db.query("SELECT role FROM ms_character_roles WHERE character_id=? ORDER BY role", [publicId(characterId)]);
    return ["player", ...rows.map(r => r.role).filter(role => role !== "player")];
  }
  async register(credentialHash, newHash, identifiers = {}) {
    const values = Object.entries(observed(identifiers));
    if (!credentialHash) check(values.some(([kind]) => UNIQUE_IDENTIFIERS.includes(kind)), "IDENTIFIER_REQUIRED");
    return this.transaction(async db => {
      let id;
      if (credentialHash) {
        const row = await db.single("SELECT user_id,revoked_at FROM ms_user_credentials WHERE token_hash=? FOR UPDATE", [credentialHash]);
        // Unknown (e.g. after a database reset) differs from revoked: only a revoked key stays blocked.
        check(row, "UNKNOWN_CREDENTIAL"); check(!row.revoked_at, "INVALID_CREDENTIAL"); id = String(row.user_id);
        await db.query(`UPDATE ms_users SET last_seen_at=${NOW} WHERE id=?`, [id]);
      } else {
        const owners = await this.owners(db, values);
        if (owners.length) {
          // Accounts created at the loading screen have no key yet: the first client claims it.
          // An account that already holds an active key is never handed over by identifiers alone.
          check(owners.length === 1, "IDENTIFIER_ALREADY_REGISTERED"); id = owners[0];
          await db.single("SELECT id FROM ms_users WHERE id=? FOR UPDATE", [id]);
          check(!(await db.single("SELECT 1 FROM ms_user_credentials WHERE user_id=? AND revoked_at IS NULL", [id])), "IDENTIFIER_ALREADY_REGISTERED");
          await db.query("INSERT INTO ms_user_credentials(token_hash,user_id) VALUES(?,?)", [newHash, id]);
          await db.query(`UPDATE ms_users SET last_seen_at=${NOW} WHERE id=?`, [id]);
          await this.audit(db, "registration", "credential.issued", id);
        } else {
          id = await this.createUser(db);
          await db.query("INSERT INTO ms_user_credentials(token_hash,user_id) VALUES(?,?)", [newHash, id]);
        }
      }
      // The unique index resolves competing registrations, including across processes.
      // Any conflict rolls back the user, credential, role and audit together.
      await this.bindIdentifiers(db, id, values);
      return this.getUser(id, db);
    });
  }
  async owners(db, values) {
    const unique = values.filter(([kind]) => UNIQUE_IDENTIFIERS.includes(kind));
    if (!unique.length) return [];
    // (kind,value) pairs as a generated OR list: row-value IN / unnest are not portable.
    const where = unique.map(() => "(kind=? AND value=?)").join(" OR ");
    return (await db.query(`SELECT DISTINCT user_id FROM ms_connection_identifiers WHERE ${where} ORDER BY user_id`,
      unique.flatMap(([kind, value]) => [kind, value]))).map(row => String(row.user_id));
  }
  // Account identifiers (Steam/Epic/Discord/hardware): only kinds the account does not have
  // yet are added; a different value of an existing kind is ignored, never a second ID.
  // IP, nickname and Discord name keep one row per kind, updated to the latest value.
  async bindIdentifiers(db, id, values) {
    await db.single("SELECT id FROM ms_users WHERE id=? FOR UPDATE", [id]);
    const known = await db.query("SELECT kind,value FROM ms_connection_identifiers WHERE user_id=? ORDER BY last_seen_at DESC", [id]);
    const added = [], ignored = [], updated = [];
    for (const [kind, value] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
      const unique = UNIQUE_IDENTIFIERS.includes(kind), rows = known.filter(row => row.kind === kind);
      // Another account's ID is always refused, even when it would be ignored here.
      if (unique) check(!(await db.single("SELECT 1 FROM ms_connection_identifiers WHERE kind=? AND value=? AND user_id<>?", [kind, value, id])), "IDENTIFIER_ALREADY_REGISTERED");
      if (!rows.length) {
        await db.query("INSERT INTO ms_connection_identifiers(user_id,kind,value) VALUES(?,?,?)", [id, kind, value]);
        added.push(kind); continue;
      }
      if (unique) {
        if (rows.some(row => row.value === value)) await db.query(`UPDATE ms_connection_identifiers SET last_seen_at=${NOW} WHERE user_id=? AND kind=? AND value=?`, [id, kind, value]);
        else ignored.push(kind);
        continue;
      }
      // Keep a single row: the matching one, or the most recent one rewritten to the new value.
      const keep = rows.find(row => row.value === value) || rows[0];
      await db.query("DELETE FROM ms_connection_identifiers WHERE user_id=? AND kind=? AND value<>?", [id, kind, keep.value]);
      await db.query(`UPDATE ms_connection_identifiers SET value=?,last_seen_at=${NOW} WHERE user_id=? AND kind=? AND value=?`, [value, id, kind, keep.value]);
      if (keep.value !== value) updated.push(kind);
    }
    return { added, ignored, updated };
  }
  async createUser(db) {
    const id = await db.insert("INSERT INTO ms_users(allowlist,metadata) VALUES('pending',?)", ["{}"]);
    await this.audit(db, "registration", "user.created", id);
    return id;
  }
  // Loading-screen admission: finds or creates the account owning the announced identifiers.
  // New accounts get no key here; the in-game client claims one after approval.
  async admission(identifiers = {}) {
    const values = Object.entries(observed(identifiers));
    check(values.some(([kind]) => UNIQUE_IDENTIFIERS.includes(kind)), "IDENTIFIER_REQUIRED");
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transaction(async db => {
          const owners = await this.owners(db, values);
          check(owners.length <= 1, "IDENTIFIER_CONFLICT");
          let id = owners[0], created = false;
          if (id) {
            // Refresh known identifiers and bind newly announced ones to the matched account.
            // Unique IDs owned by another account were excluded above (IDENTIFIER_CONFLICT);
            // a concurrent claim hits the unique index and is retried once.
            await db.query(`UPDATE ms_users SET last_seen_at=${NOW} WHERE id=?`, [id]);
            const { added, ignored } = await this.bindIdentifiers(db, id, values);
            if (added.length || ignored.length) await this.audit(db, "registration", "identifiers.added", id, { kinds: added, ignored });
          } else {
            id = await this.createUser(db); created = true;
            await this.bindIdentifiers(db, id, values);
          }
          return { ...(await this.getUser(id, db)), created };
        });
      } catch (error) {
        // A concurrent handshake created the owner first: look it up again once.
        if (error.code === "IDENTIFIER_ALREADY_REGISTERED" && attempt === 0) continue;
        throw error;
      }
    }
  }
  async revokeCredentials(id, actor) {
    await this.transaction(async db => {
      check(await this.getUser(id, db), "USER_NOT_FOUND");
      await db.query(`UPDATE ms_user_credentials SET revoked_at=${NOW} WHERE user_id=? AND revoked_at IS NULL`, [id]);
      await this.audit(db, actor, "credential.revoked", id);
    });
  }
  async verifyCredential(tokenHash, userId) {
    return Boolean(await this.sql.single("SELECT 1 FROM ms_user_credentials WHERE token_hash=? AND user_id=? AND revoked_at IS NULL", [tokenHash, publicId(userId)]));
  }
  async recoverCredential(pendingId, originalId, actor) {
    pendingId = publicId(pendingId); originalId = publicId(originalId); check(pendingId !== originalId, "INVALID_ID");
    await this.transaction(async db => {
      const rows = await db.query("SELECT id,allowlist FROM ms_users WHERE id=? OR id=? ORDER BY id FOR UPDATE", [pendingId, originalId]);
      check(rows.length === 2 && rows.find(row => String(row.id) === pendingId).allowlist === "pending", "RECOVERY_REQUIRES_PENDING_ACCOUNT");
      // A pending account created at the loading screen may have no key yet; the next
      // client with its identifiers then claims the original account.
      await db.query(`UPDATE ms_user_credentials SET revoked_at=${NOW} WHERE user_id=? AND revoked_at IS NULL`, [originalId]);
      await db.query("UPDATE ms_user_credentials SET user_id=? WHERE user_id=? AND revoked_at IS NULL", [originalId, pendingId]);
      // Identifiers both accounts hold: merge the timestamps into the original row and drop the pending
      // duplicate (decided in JS; UPDATE ... FROM / DELETE ... USING are not portable). The rest move over.
      const columns = "SELECT kind,value,first_seen_at,last_seen_at FROM ms_connection_identifiers WHERE user_id=?";
      const original = await db.query(columns, [originalId]), pending = await db.query(columns, [pendingId]);
      for (const row of pending) {
        const twin = original.find(item => item.kind === row.kind && item.value === row.value);
        if (!twin) continue;
        const first = new Date(Math.min(twin.first_seen_at, row.first_seen_at)), last = new Date(Math.max(twin.last_seen_at, row.last_seen_at));
        await db.query("UPDATE ms_connection_identifiers SET first_seen_at=?,last_seen_at=? WHERE user_id=? AND kind=? AND value=?", [first, last, originalId, row.kind, row.value]);
        await db.query("DELETE FROM ms_connection_identifiers WHERE user_id=? AND kind=? AND value=?", [pendingId, row.kind, row.value]);
      }
      await db.query("UPDATE ms_connection_identifiers SET user_id=? WHERE user_id=?", [originalId, pendingId]);
      await db.query("UPDATE ms_users SET allowlist='denied' WHERE id=?", [pendingId]);
      await this.audit(db, actor, "credential.recovered", originalId, { replacedPendingUserId: pendingId });
    });
  }
  async listUsers() {
    return (await this.sql.query("SELECT id,allowlist,created_at FROM ms_users ORDER BY id DESC LIMIT 200"))
      .map(row => ({ userId: String(row.id), allowlist: row.allowlist, createdAt: row.created_at }));
  }
  async startSession(playerId, serverKey) {
    return this.sql.insert("INSERT INTO ms_sessions(player_id,server_key) VALUES(?,?)", [playerId, serverKey]);
  }
  async bindSession(id, userId) {
    check(await this.sql.update("UPDATE ms_sessions SET user_id=? WHERE id=? AND ended_at IS NULL AND user_id IS NULL", [userId, id]) === 1, "SESSION_EXPIRED");
  }
  async endSession(id, reason) { await this.sql.query(`UPDATE ms_sessions SET ended_at=${NOW},end_reason=? WHERE id=? AND ended_at IS NULL`, [String(reason).slice(0, 100), id]); }
  async endAbandonedSessions(serverKey) { await this.sql.query(`UPDATE ms_sessions SET ended_at=${NOW},end_reason='resourceRestart' WHERE server_key=? AND ended_at IS NULL`, [serverKey]); }
  async setAllowlist(id, status, actor, reason = "") {
    check(["pending", "approved", "denied"].includes(status), "INVALID_ALLOWLIST");
    check(typeof reason === "string" && reason.length <= 500, "INVALID_REASON");
    await this.transaction(async db => {
      check(await db.update("UPDATE ms_users SET allowlist=? WHERE id=?", [status, publicId(id)]) === 1, "USER_NOT_FOUND");
      await this.audit(db, actor, "allowlist." + status, id, { reason });
    }); return this.getUser(id);
  }
  // Roles belong to a character. The implicit "player" role is never stored. ms-core does not own ms_characters,
  // so the character id is not verified here; callers (ms-character, admin tool) pass ids they got from there.
  async setRole(characterId, role, enabled, actor) {
    characterId = publicId(characterId);
    check(typeof role === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(role) && role !== "player", "INVALID_ROLE");
    await this.transaction(async db => {
      if (enabled) {
        // Idempotent add without ON CONFLICT: the primary key rejects a duplicate, checked first.
        if (!(await db.single("SELECT 1 FROM ms_character_roles WHERE character_id=? AND role=?", [characterId, role]))) {
          await db.query("INSERT INTO ms_character_roles(character_id,role) VALUES(?,?)", [characterId, role]);
        }
      } else await db.query("DELETE FROM ms_character_roles WHERE character_id=? AND role=?", [characterId, role]);
      await this.audit(db, actor, enabled ? "role.add" : "role.remove", null, { role, characterId });
    }); return this.characterRoles(characterId);
  }
  async activeBan(id) {
    const row = await this.sql.single(`SELECT id,reason,expires_at FROM ms_bans WHERE user_id=? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>${NOW}) ORDER BY created_at DESC,id DESC LIMIT 1`, [publicId(id)]);
    return row ? { ...row, id: String(row.id) } : null;
  }
  async ban(id, reason, expiresAt, actor) {
    check(typeof reason === "string" && reason.trim().length > 0 && reason.length <= 500, "INVALID_REASON");
    check(expiresAt === null || (Number.isSafeInteger(expiresAt) && expiresAt > Date.now()), "INVALID_EXPIRY");
    return this.transaction(async db => {
      check(await this.getUser(id, db), "USER_NOT_FOUND");
      const banId = await db.insert("INSERT INTO ms_bans(user_id,reason,actor,expires_at) VALUES(?,?,?,?)", [id, reason, actor, expiresAt === null ? null : new Date(expiresAt)]);
      await this.audit(db, actor, "ban.created", id, { banId, reason, expiresAt });
      return banId;
    });
  }
  async unban(id, actor) {
    await this.transaction(async db => {
      check(await this.getUser(id, db), "USER_NOT_FOUND");
      await db.query(`UPDATE ms_bans SET revoked_at=${NOW} WHERE user_id=? AND revoked_at IS NULL`, [id]);
      await this.audit(db, actor, "ban.revoked", id);
    });
  }
  async setMetadata(id, key, value, actor) {
    return this.transaction(async db => {
      const row = await db.single("SELECT metadata FROM ms_users WHERE id=? FOR UPDATE", [publicId(id)]);
      check(row, "USER_NOT_FOUND"); row.metadata[key] = value;
      await db.query("UPDATE ms_users SET metadata=? WHERE id=?", [json(row.metadata, 65536), id]);
      await this.audit(db, actor, "user.metadata", id, { key }); return this.getUser(id, db);
    });
  }
}
module.exports = { Repository };
