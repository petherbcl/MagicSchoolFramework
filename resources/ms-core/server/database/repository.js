"use strict";
const { Pool } = require("pg");
const schema = require("./schema");
const { check, json, characterInput, publicId, CoreError, observed, UNIQUE_IDENTIFIERS } = require("../validation");

class Repository {
  constructor(config, { pool } = {}) {
    this.pool = pool || new Pool({ connectionString: config.databaseUrl, max: config.poolSize,
      connectionTimeoutMillis: config.queryTimeoutMs, statement_timeout: config.queryTimeoutMs,
      idleTimeoutMillis: 10000, application_name: "MagicSchoolRP-ms-core" });
    this.pool.on?.("error", () => {});
  }
  async transaction(fn) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
    catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.code === "23505" && error.constraint === "ms_connection_identifiers_unique_owner") throw new CoreError("IDENTIFIER_ALREADY_REGISTERED");
      throw error;
    }
    finally { client.release(); }
  }
  async createSchema() {
    await this.transaction(async db => {
      // Concurrent CREATE ... IF NOT EXISTS (server + admin tool) can still collide without the lock.
      await db.query("SELECT pg_advisory_xact_lock(684331905)");
      await db.query(schema);
    });
  }
  async audit(db, actor, action, userId, details = {}) {
    await db.query("INSERT INTO ms_core.ms_audit_log(actor,action,user_id,details) VALUES($1,$2,$3,$4)", [actor, action, userId, json(details)]);
  }
  async getUser(id, db = this.pool) {
    const row = (await db.query("SELECT * FROM ms_core.ms_users WHERE id=$1", [publicId(id)])).rows[0];
    if (!row) return null;
    const roles = (await db.query("SELECT role FROM ms_core.ms_user_roles WHERE user_id=$1 ORDER BY role", [id])).rows.map(r => r.role);
    return { userId: String(row.id), allowlist: row.allowlist, metadata: row.metadata, roles, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
  }
  async register(credentialHash, newHash, identifiers = {}) {
    const values = Object.entries(observed(identifiers));
    if (!credentialHash) check(values.some(([kind]) => UNIQUE_IDENTIFIERS.includes(kind)), "IDENTIFIER_REQUIRED");
    return this.transaction(async db => {
      let id;
      if (credentialHash) {
        const row = (await db.query("SELECT user_id,revoked_at FROM ms_core.ms_user_credentials WHERE token_hash=$1 FOR UPDATE", [credentialHash])).rows[0];
        // Unknown (e.g. after a database reset) differs from revoked: only a revoked key stays blocked.
        check(row, "UNKNOWN_CREDENTIAL"); check(!row.revoked_at, "INVALID_CREDENTIAL"); id = String(row.user_id);
        await db.query("UPDATE ms_core.ms_users SET last_seen_at=now() WHERE id=$1", [id]);
      } else {
        const owners = await this.owners(db, values);
        if (owners.length) {
          // Accounts created at the loading screen have no key yet: the first client claims it.
          // An account that already holds an active key is never handed over by identifiers alone.
          check(owners.length === 1, "IDENTIFIER_ALREADY_REGISTERED"); id = owners[0];
          await db.query("SELECT id FROM ms_core.ms_users WHERE id=$1 FOR UPDATE", [id]);
          check(!(await db.query("SELECT 1 FROM ms_core.ms_user_credentials WHERE user_id=$1 AND revoked_at IS NULL", [id])).rowCount, "IDENTIFIER_ALREADY_REGISTERED");
          await db.query("INSERT INTO ms_core.ms_user_credentials(token_hash,user_id) VALUES($1,$2)", [newHash, id]);
          await db.query("UPDATE ms_core.ms_users SET last_seen_at=now() WHERE id=$1", [id]);
          await this.audit(db, "registration", "credential.issued", id);
        } else {
          id = await this.createUser(db);
          await db.query("INSERT INTO ms_core.ms_user_credentials(token_hash,user_id) VALUES($1,$2)", [newHash, id]);
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
    return (await db.query(`SELECT DISTINCT user_id FROM ms_core.ms_connection_identifiers
      WHERE (kind,value) IN (SELECT * FROM unnest($1::text[],$2::text[])) ORDER BY user_id`,
    [unique.map(([kind]) => kind), unique.map(([, value]) => value)])).rows.map(row => String(row.user_id));
  }
  // Account identifiers (Steam/Epic/Discord/hardware): only kinds the account does not have
  // yet are added; a different value of an existing kind is ignored, never a second ID.
  // IP, nickname and Discord name keep one row per kind, updated to the latest value.
  async bindIdentifiers(db, id, values) {
    await db.query("SELECT id FROM ms_core.ms_users WHERE id=$1 FOR UPDATE", [id]);
    const known = (await db.query("SELECT kind,value FROM ms_core.ms_connection_identifiers WHERE user_id=$1 ORDER BY last_seen_at DESC", [id])).rows;
    const added = [], ignored = [], updated = [];
    for (const [kind, value] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
      const unique = UNIQUE_IDENTIFIERS.includes(kind), rows = known.filter(row => row.kind === kind);
      // Another account's ID is always refused, even when it would be ignored here.
      if (unique) check(!(await db.query("SELECT 1 FROM ms_core.ms_connection_identifiers WHERE kind=$1 AND value=$2 AND user_id<>$3", [kind, value, id])).rowCount, "IDENTIFIER_ALREADY_REGISTERED");
      if (!rows.length) {
        await db.query("INSERT INTO ms_core.ms_connection_identifiers(user_id,kind,value) VALUES($1,$2,$3)", [id, kind, value]);
        added.push(kind); continue;
      }
      if (unique) {
        if (rows.some(row => row.value === value)) await db.query("UPDATE ms_core.ms_connection_identifiers SET last_seen_at=now() WHERE user_id=$1 AND kind=$2 AND value=$3", [id, kind, value]);
        else ignored.push(kind);
        continue;
      }
      // Keep a single row: the matching one, or the most recent one rewritten to the new value.
      const keep = rows.find(row => row.value === value) || rows[0];
      await db.query("DELETE FROM ms_core.ms_connection_identifiers WHERE user_id=$1 AND kind=$2 AND value<>$3", [id, kind, keep.value]);
      await db.query("UPDATE ms_core.ms_connection_identifiers SET value=$4,last_seen_at=now() WHERE user_id=$1 AND kind=$2 AND value=$3", [id, kind, keep.value, value]);
      if (keep.value !== value) updated.push(kind);
    }
    return { added, ignored, updated };
  }
  async createUser(db) {
    const id = String((await db.query("INSERT INTO ms_core.ms_users DEFAULT VALUES RETURNING id")).rows[0].id);
    await db.query("INSERT INTO ms_core.ms_user_roles VALUES($1,'player')", [id]);
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
            await db.query("UPDATE ms_core.ms_users SET last_seen_at=now() WHERE id=$1", [id]);
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
      await db.query("UPDATE ms_core.ms_user_credentials SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
      await this.audit(db, actor, "credential.revoked", id);
    });
  }
  async verifyCredential(tokenHash, userId) {
    return Boolean((await this.pool.query("SELECT 1 FROM ms_core.ms_user_credentials WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL", [tokenHash, publicId(userId)])).rowCount);
  }
  async recoverCredential(pendingId, originalId, actor) {
    pendingId = publicId(pendingId); originalId = publicId(originalId); check(pendingId !== originalId, "INVALID_ID");
    await this.transaction(async db => {
      const rows = (await db.query("SELECT id,allowlist FROM ms_core.ms_users WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE", [pendingId, originalId])).rows;
      check(rows.length === 2 && rows.find(row => String(row.id) === pendingId).allowlist === "pending", "RECOVERY_REQUIRES_PENDING_ACCOUNT");
      check(Number((await db.query("SELECT count(*) AS n FROM ms_core.ms_characters WHERE user_id=$1", [pendingId])).rows[0].n) === 0, "RECOVERY_REQUIRES_EMPTY_ACCOUNT");
      // A pending account created at the loading screen may have no key yet; the next
      // client with its identifiers then claims the original account.
      await db.query("UPDATE ms_core.ms_user_credentials SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [originalId]);
      await db.query("UPDATE ms_core.ms_user_credentials SET user_id=$1 WHERE user_id=$2 AND revoked_at IS NULL", [originalId, pendingId]);
      await db.query(`UPDATE ms_core.ms_connection_identifiers a SET first_seen_at=least(a.first_seen_at,b.first_seen_at),last_seen_at=greatest(a.last_seen_at,b.last_seen_at)
        FROM ms_core.ms_connection_identifiers b WHERE a.user_id=$1 AND b.user_id=$2 AND a.kind=b.kind AND a.value=b.value`, [originalId, pendingId]);
      await db.query(`DELETE FROM ms_core.ms_connection_identifiers b USING ms_core.ms_connection_identifiers a
        WHERE a.user_id=$1 AND b.user_id=$2 AND a.kind=b.kind AND a.value=b.value`, [originalId, pendingId]);
      await db.query("UPDATE ms_core.ms_connection_identifiers SET user_id=$1 WHERE user_id=$2", [originalId, pendingId]);
      await db.query("UPDATE ms_core.ms_users SET allowlist='denied' WHERE id=$1", [pendingId]);
      await this.audit(db, actor, "credential.recovered", originalId, { replacedPendingUserId: pendingId });
    });
  }
  async listUsers() { return (await this.pool.query('SELECT id::text AS "userId",allowlist,created_at AS "createdAt" FROM ms_core.ms_users ORDER BY id DESC LIMIT 200')).rows; }
  async startSession(playerId, serverKey) {
    return String((await this.pool.query("INSERT INTO ms_core.ms_sessions(player_id,server_key) VALUES($1,$2) RETURNING id", [playerId, serverKey])).rows[0].id);
  }
  async bindSession(id, userId) {
    check((await this.pool.query("UPDATE ms_core.ms_sessions SET user_id=$1 WHERE id=$2 AND ended_at IS NULL AND user_id IS NULL", [userId, id])).rowCount === 1, "SESSION_EXPIRED");
  }
  async endSession(id, reason) { await this.pool.query("UPDATE ms_core.ms_sessions SET ended_at=now(),end_reason=$1 WHERE id=$2 AND ended_at IS NULL", [String(reason).slice(0, 100), id]); }
  async endAbandonedSessions(serverKey) { await this.pool.query("UPDATE ms_core.ms_sessions SET ended_at=now(),end_reason='resourceRestart' WHERE server_key=$1 AND ended_at IS NULL", [serverKey]); }
  async setAllowlist(id, status, actor, reason = "") {
    check(["pending", "approved", "denied"].includes(status), "INVALID_ALLOWLIST");
    check(typeof reason === "string" && reason.length <= 500, "INVALID_REASON");
    await this.transaction(async db => {
      check((await db.query("UPDATE ms_core.ms_users SET allowlist=$1 WHERE id=$2", [status, publicId(id)])).rowCount === 1, "USER_NOT_FOUND");
      await this.audit(db, actor, "allowlist." + status, id, { reason });
    }); return this.getUser(id);
  }
  async setRole(id, role, enabled, actor) {
    check(typeof role === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(role), "INVALID_ROLE");
    await this.transaction(async db => {
      check(await this.getUser(id, db), "USER_NOT_FOUND");
      if (enabled) await db.query("INSERT INTO ms_core.ms_user_roles VALUES($1,$2) ON CONFLICT DO NOTHING", [id, role]);
      else await db.query("DELETE FROM ms_core.ms_user_roles WHERE user_id=$1 AND role=$2", [id, role]);
      await this.audit(db, actor, enabled ? "role.add" : "role.remove", id, { role });
    }); return this.getUser(id);
  }
  async activeBan(id) { return (await this.pool.query("SELECT id,reason,expires_at FROM ms_core.ms_bans WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC LIMIT 1", [publicId(id)])).rows[0] || null; }
  async ban(id, reason, expiresAt, actor) {
    check(typeof reason === "string" && reason.trim().length > 0 && reason.length <= 500, "INVALID_REASON");
    check(expiresAt === null || (Number.isSafeInteger(expiresAt) && expiresAt > Date.now()), "INVALID_EXPIRY");
    return this.transaction(async db => {
      check(await this.getUser(id, db), "USER_NOT_FOUND");
      const banId = String((await db.query("INSERT INTO ms_core.ms_bans(user_id,reason,actor,expires_at) VALUES($1,$2,$3,$4) RETURNING id", [id, reason, actor, expiresAt === null ? null : new Date(expiresAt)])).rows[0].id);
      await this.audit(db, actor, "ban.created", id, { banId, reason, expiresAt });
      return banId;
    });
  }
  async unban(id, actor) {
    await this.transaction(async db => {
      check(await this.getUser(id, db), "USER_NOT_FOUND");
      await db.query("UPDATE ms_core.ms_bans SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
      await this.audit(db, actor, "ban.revoked", id);
    });
  }
  async setMetadata(id, key, value, actor) {
    return this.transaction(async db => {
      const row = (await db.query("SELECT metadata FROM ms_core.ms_users WHERE id=$1 FOR UPDATE", [publicId(id)])).rows[0];
      check(row, "USER_NOT_FOUND"); row.metadata[key] = value;
      await db.query("UPDATE ms_core.ms_users SET metadata=$1 WHERE id=$2", [json(row.metadata, 65536), id]);
      await this.audit(db, actor, "user.metadata", id, { key }); return this.getUser(id, db);
    });
  }
  mapCharacter(row) { return row ? { characterId: String(row.id), userId: String(row.user_id), firstName: row.first_name, lastName: row.last_name, house: row.house, state: row.state, version: row.version } : null; }
  async getCharacter(id) { return this.mapCharacter((await this.pool.query("SELECT * FROM ms_core.ms_characters WHERE id=$1", [publicId(id)])).rows[0]); }
  async listCharacters(id) { return (await this.pool.query("SELECT * FROM ms_core.ms_characters WHERE user_id=$1 ORDER BY id", [publicId(id)])).rows.map(row => this.mapCharacter(row)); }
  async createCharacter(userId, input, maxCharacters) {
    const value = characterInput(input);
    return this.transaction(async db => {
      check((await db.query("SELECT id FROM ms_core.ms_users WHERE id=$1 FOR UPDATE", [publicId(userId)])).rowCount, "USER_NOT_FOUND");
      check(Number((await db.query("SELECT count(*) AS n FROM ms_core.ms_characters WHERE user_id=$1", [userId])).rows[0].n) < maxCharacters, "CHARACTER_LIMIT");
      const row = (await db.query("INSERT INTO ms_core.ms_characters(user_id,first_name,last_name,house) VALUES($1,$2,$3,$4) RETURNING *", [userId, value.firstName, value.lastName, value.house])).rows[0];
      await this.audit(db, "user:" + userId, "character.created", userId, { characterId: String(row.id) }); return this.mapCharacter(row);
    });
  }
  async saveCharacter(id, userId, expectedVersion, state) {
    const result = await this.pool.query("UPDATE ms_core.ms_characters SET state=$1,version=version+1,updated_at=now() WHERE id=$2 AND user_id=$3 AND version=$4 RETURNING *", [json(state, 2 * 1024 * 1024), publicId(id), publicId(userId), expectedVersion]);
    check(result.rowCount === 1, "REVISION_CONFLICT"); return this.mapCharacter(result.rows[0]);
  }
  async close() { if (!this.closed) { this.closed = true; await this.pool.end(); } }
}
module.exports = { Repository };
