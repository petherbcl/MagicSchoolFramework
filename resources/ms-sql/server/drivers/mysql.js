"use strict";

// MySQL and MariaDB share this adapter. Differences handled here (plan section 3.3): FOUND_ROWS so
// affectedRows counts matched rows like PostgreSQL, READ COMMITTED and UTC per connection, BIGINT as
// strings, and JSON columns of MariaDB (a LONGTEXT alias) parsed back to values.

const BLOB_TYPES = new Set([249, 250, 251, 252]); // TINY/MEDIUM/LONG/BLOB: servers differ in which one a LONGTEXT (the MariaDB JSON alias) reports
const JSON_VALID = /json_valid\(\s*`?([^`)\s]+)`?\s*\)/gi;
const FATAL_CODES = new Set(["PROTOCOL_SEQUENCE_TIMEOUT", "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);

// SEC-01: mysql2 `query` escapes values on the client with backslash rules and never learns the session
// sql_mode, so NO_BACKSLASH_ESCAPES (where ' is not an escape) would turn that escaping into an injection.
// ANSI_QUOTES also changes how the tokenizer must read double quotes. Both are removed from every session and
// the rest of the server mode is kept. One statement (no read-then-set), so no query can run in between.
// R-04: STRICT_ALL_TABLES is also guaranteed (added only when missing), so a server with sql_mode='' cannot
// silently truncate long values. The result is confirmed afterwards with SELECT @@SESSION.sql_mode.
const SQL_MODE_STATEMENT = "SET SESSION sql_mode = CONCAT_WS(',', "
  + "NULLIF(TRIM(BOTH ',' FROM REPLACE(REPLACE(CONCAT(',', @@sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','), ',ANSI_QUOTES,', ',')), ''), "
  + "IF(FIND_IN_SET('STRICT_ALL_TABLES', @@sql_mode), NULL, 'STRICT_ALL_TABLES'))";
const SQL_MODE_CHECK = "SELECT @@SESSION.sql_mode AS sql_mode";

// True only when the confirmed session mode has no dangerous mode and has STRICT_ALL_TABLES.
function sqlModeIsSafe(rows) {
  const mode = Array.isArray(rows) && rows[0] ? rows[0].sql_mode : undefined;
  if (typeof mode !== "string") return false;
  const modes = mode.toUpperCase().split(",").map(part => part.trim());
  return !modes.includes("NO_BACKSLASH_ESCAPES") && !modes.includes("ANSI_QUOTES") && modes.includes("STRICT_ALL_TABLES");
}

function connectionOptions(config) {
  // The database in the URL path is ignored on purpose: in MySQL/MariaDB the schema IS the database and
  // comes from config.schema (main.js warns when the path differs). No database here = bootstrap options.
  const url = new URL(config.url);
  return {
    host: decodeURIComponent(url.hostname.replace(/^\[|\]$/g, "")), port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  };
}

function shapeHeader(header) {
  const id = header.insertId;
  return {
    affectedRows: header.affectedRows,
    insertId: id === undefined || id === null || Number(id) === 0 ? null : String(id),
    changedRows: header.changedRows ?? 0,
  };
}

function createMysqlDriver(config, { mysql } = {}) {
  const lib = mysql || require("mysql2/promise");
  const dialect = config.dialect === "mariadb" ? "mariadb" : "mysql";
  const pool = lib.createPool({
    ...connectionOptions(config), database: config.schema,
    connectionLimit: config.poolSize, waitForConnections: true, queueLimit: 0,
    connectTimeout: config.queryTimeoutMs, charset: "utf8mb4", timezone: "Z",
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, namedPlaceholders: false,
    flags: ["+FOUND_ROWS"],
    ssl: config.ssl ? { rejectUnauthorized: true, ...(config.sslCa ? { ca: config.sslCa } : {}) } : undefined,
  });
  // Per-connection session settings. mysql2 queues commands, so these run before any later query.
  pool.pool.on("connection", connection => {
    const fail = error => { if (error) connection.destroy(); };
    connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED", fail);
    connection.query("SET time_zone = '+00:00'", fail);
    connection.query(SQL_MODE_STATEMENT, fail);
    // Fail closed: a connection whose mode cannot be confirmed is destroyed, never used.
    connection.query(SQL_MODE_CHECK, (error, rows) => { if (error || !sqlModeIsSafe(rows)) connection.destroy(); });
  });

  // Creates the database once when it does not exist, over a short-lived connection without a database.
  // SCHEMATA is checked first so an existing database needs no CREATE privilege (SEC-04).
  async function ensureSchema() {
    const conn = await lib.createConnection({
      ...connectionOptions(config), connectTimeout: config.queryTimeoutMs, charset: "utf8mb4",
      ssl: config.ssl ? { rejectUnauthorized: true, ...(config.sslCa ? { ca: config.sslCa } : {}) } : undefined,
    });
    try {
      const exists = async () => (await conn.query({ sql: "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", values: [config.schema], timeout: config.queryTimeoutMs }))[0].length > 0;
      if (await exists()) return;
      // Validated by loadConfig: letters, digits and underscore only, so the backtick quoting is safe.
      try { await conn.query({ sql: "CREATE DATABASE IF NOT EXISTS `" + config.schema + "` CHARACTER SET utf8mb4", timeout: config.queryTimeoutMs }); }
      catch (error) { if (!(await exists().catch(() => false))) throw error; }
    } finally { await conn.end().catch(() => {}); }
  }

  const jsonColumnCache = new Map(); // "schema.table" -> Set of JSON column names (MariaDB only)
  async function jsonColumns(conn, field) {
    const key = field.schema + "." + field.orgTable;
    if (jsonColumnCache.has(key)) return jsonColumnCache.get(key);
    const columns = new Set();
    try {
      const [rows] = await conn.query({
        sql: "SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CHECK_CLAUSE LIKE '%json_valid%'",
        values: [field.schema, field.orgTable], timeout: config.queryTimeoutMs,
      });
      for (const row of rows) for (const match of String(row.CHECK_CLAUSE).matchAll(JSON_VALID)) columns.add(match[1]);
      jsonColumnCache.set(key, columns);
    } catch { /* lookup failed: leave the text untouched and retry on the next query */ }
    return columns;
  }
  async function parseJsonColumns(conn, rows, fields) {
    if (dialect !== "mariadb" || !rows.length || !fields) return rows;
    const names = [];
    for (const field of fields) {
      if (!BLOB_TYPES.has(field.columnType) || !field.orgTable || !field.schema) continue;
      if ((await jsonColumns(conn, field)).has(field.orgName)) names.push(field.name);
    }
    for (const row of rows) for (const name of names) {
      if (typeof row[name] !== "string") continue;
      try { row[name] = JSON.parse(row[name]); } catch { /* not valid JSON: keep the text */ }
    }
    return rows;
  }

  async function execute(conn, text, values, { prepared } = {}) {
    const request = { sql: text, values, timeout: config.queryTimeoutMs };
    const [first, fields] = prepared ? await conn.execute(request) : await conn.query(request);
    return Array.isArray(first) ? parseJsonColumns(conn, first, fields) : shapeHeader(first);
  }

  // mysql2 has no acquire timeout: without one an exhausted pool would queue forever.
  async function connect() {
    let timer, abandoned = false;
    const pending = pool.getConnection();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        reject(Object.assign(new Error("Timed out waiting for a free database connection"), { code: "POOL_ACQUIRE_TIMEOUT" }));
      }, config.queryTimeoutMs);
    });
    try { return await Promise.race([pending, timeout]); }
    finally {
      clearTimeout(timer);
      if (abandoned) pending.then(conn => conn.release(), () => {});
    }
  }
  const isBroken = error => Boolean(error && (error.fatal || FATAL_CODES.has(error.code)));
  const wrap = conn => ({
    run: (text, values, options) => execute(conn, text, values, options),
    begin: () => conn.query("START TRANSACTION"),
    commit: () => conn.query("COMMIT"),
    rollback: () => conn.query("ROLLBACK"),
    async lock(name, timeoutMs) {
      const [rows] = await conn.query({ sql: "SELECT GET_LOCK(?, ?) AS ok", values: [name, timeoutMs / 1000], timeout: timeoutMs + config.queryTimeoutMs });
      return Number(rows[0].ok) === 1;
    },
    unlock: name => conn.query({ sql: "SELECT RELEASE_LOCK(?)", values: [name] }),
    release(broken) { if (broken) conn.destroy(); else conn.release(); },
  });

  return {
    dialect,
    async run(text, values, options) {
      const conn = await connect();
      let broken = false;
      try { return await execute(conn, text, values, options); }
      catch (error) { broken = isBroken(error); throw error; }
      finally { if (broken) conn.destroy(); else conn.release(); }
    },
    init: ensureSchema,
    async acquire() { return wrap(await connect()); },
    async ping() {
      const conn = await connect();
      try { await conn.query({ sql: "SELECT 1", timeout: config.queryTimeoutMs }); conn.release(); }
      catch (error) { conn.destroy(); throw error; }
    },
    end: () => pool.end(),
  };
}

module.exports = { createMysqlDriver };
