"use strict";

const crypto = require("node:crypto");

const LOCK_POLL_MS = 50;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Result contract shared by every driver: an array of rows when the statement returns a result set,
// otherwise { affectedRows, insertId, changedRows } (insertId is always null here: PostgreSQL uses RETURNING).
function shape(result) {
  if (result.fields && result.fields.length > 0) return result.rows;
  const count = result.rowCount ?? 0;
  return { affectedRows: count, insertId: null, changedRows: count };
}

// pg identifies a prepared statement by name per connection, so the name must follow the SQL text.
const statementName = text => "ms_" + crypto.createHash("sha1").update(text).digest("hex").slice(0, 32);
const lockKey = name => BigInt.asIntN(64, crypto.createHash("sha256").update(name).digest().readBigUInt64BE(0)).toString();

// Only host, port, user, password and database are read from the URL. Everything else in the query string
// (sslmode, statement_timeout, options, host...) is ignored on purpose: pg lets a connection string override
// code options, which would defeat MS_SQL_SSL and the query timeout (SEC-02).
function connectionOptions(config) {
  const url = new URL(config.url);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return {
    host: decodeURIComponent(url.hostname.replace(/^\[|\]$/g, "")), port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ...(database ? { database } : {}),
  };
}

function createPostgresDriver(config, { Pool } = {}) {
  const PgPool = Pool || require("pg").Pool;
  // Every pooled connection resolves unqualified names inside the configured schema. The SET runs inside
  // connect(), before pg-pool hands the client out, so no query can ever see another search_path and a failure
  // rejects the connection (fail closed). A per-connection SET is used instead of the "-c search_path" startup
  // option because pgbouncer rejects startup options and PGlite ignores them.
  const quoted = '"' + config.schema + '"'; // validated by loadConfig: letters, digits and underscore only
  const setSearchPath = "SET search_path TO " + quoted;
  class SchemaClient extends require("pg").Client {
    connect(callback) {
      if (!callback) return super.connect().then(() => this.query(setSearchPath)).then(() => undefined);
      return super.connect(error => {
        if (error) return callback(error);
        this.query(setSearchPath, failure => { if (failure) { this.end(() => {}); callback(failure); } else callback(); });
      });
    }
  }

  const pool = new PgPool({
    ...connectionOptions(config), Client: SchemaClient, max: config.poolSize, connectionTimeoutMillis: config.queryTimeoutMs,
    statement_timeout: config.queryTimeoutMs,
    // Client-side backstop: a query must never hang even if the server ignores statement_timeout.
    query_timeout: config.queryTimeoutMs + 1000,
    idleTimeoutMillis: 10000, application_name: "MagicSchoolRP-ms-sql",
    ssl: config.ssl ? { rejectUnauthorized: true, ...(config.sslCa ? { ca: config.sslCa } : {}) } : false,
  });
  pool.on("error", () => {}); // idle client errors must not take the process down

  // Creates the schema once when it does not exist. Checking first keeps the minimum privilege story
  // (SEC-04) honest: an existing schema needs no CREATE on the database, and PostgreSQL checks that
  // privilege even for CREATE SCHEMA IF NOT EXISTS.
  async function ensureSchema() {
    const exists = () => pool.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1", [config.schema]).then(r => r.rowCount > 0);
    if (await exists()) return;
    try { await pool.query("CREATE SCHEMA IF NOT EXISTS " + quoted); }
    catch (error) { if (!(await exists().catch(() => false))) throw error; } // lost a creation race: fine
  }

  const execute = async (target, text, values, { prepared } = {}) =>
    shape(await target.query(prepared ? { text, values, name: statementName(text) } : { text, values }));

  return {
    dialect: "postgres",
    run: (text, values, options) => execute(pool, text, values, options),
    async acquire() {
      const client = await pool.connect();
      const swallow = () => {};
      client.on("error", swallow); // a checked-out client emitting "error" would otherwise be uncaught
      return {
        run: (text, values, options) => execute(client, text, values, options),
        begin: () => client.query("BEGIN"),
        commit: () => client.query("COMMIT"),
        rollback: () => client.query("ROLLBACK"),
        // Polls pg_try_advisory_lock so the wait honours timeoutMs instead of blocking the connection.
        async lock(name, timeoutMs) {
          const key = lockKey(name), deadline = Date.now() + timeoutMs;
          for (;;) {
            const { rows } = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS ok", [key]);
            if (rows[0].ok === true) return true;
            if (Date.now() >= deadline) return false;
            await sleep(LOCK_POLL_MS);
          }
        },
        unlock: name => client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey(name)]),
        release(broken) { client.removeListener("error", swallow); client.release(broken ? true : undefined); },
      };
    },
    init: ensureSchema,
    async ping() { await pool.query("SELECT 1"); },
    end: () => pool.end(),
  };
}

module.exports = { createPostgresDriver };
