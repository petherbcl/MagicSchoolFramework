"use strict";

const { SqlError, mapError } = require("./errors");
const { translate: baseTranslate } = require("./placeholders");
const { createDriver } = require("./drivers");

const RETURNING_COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LOCK_NAME_MAX = 64;
const DEFAULT_LOCK_TIMEOUT_MS = 30000;
const DEFAULT_LIMITS = Object.freeze({ maxSqlBytes: 1048576, maxParams: 65535, maxBatch: 10000, holdTimeoutMs: 60000 });
const SLOW_SQL_PREVIEW = 200;
const noop = () => {};
// pg "Query read timeout" (no code) and mysql2 PROTOCOL_SEQUENCE_TIMEOUT: raised by the driver, not by the server.
const isClientTimeout = error => Boolean(error && (error.code === "PROTOCOL_SEQUENCE_TIMEOUT" || (!error.code && /query read timeout/i.test(error.message || ""))));
const silent = { info: noop, warn: noop, error: noop };

const invalid = message => new SqlError("INVALID_PARAMS", message);
const notReady = () => new SqlError("NOT_READY", "Database is not ready");

// Resolves true when `promise` settles first, false on timeout.
function settledWithin(promise, ms, setTimer) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimer(() => resolve(false), ms); });
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

// createSql wires a driver to the public API. It is pure: config, driver, logger, clock, callbacks and
// timers are injected, which is what the tests replace. Only server/main.js touches runtime globals.
// The returned object is the frozen API. It includes close() for the owner (main.js); the object that
// is registered as the public export should be a view without it.
function createSql({ config, driver, logger = silent, clock = Date.now, onReady, onDown, backoff = {}, setTimer = setTimeout } = {}) {
  if (!config) throw new Error("createSql requires config");
  const configured = Boolean(config.databaseConfigured || driver);
  const slowQueryMs = config.slowQueryMs ?? 0;
  const limits = {
    maxSqlBytes: config.maxSqlBytes ?? DEFAULT_LIMITS.maxSqlBytes, maxParams: config.maxParams ?? DEFAULT_LIMITS.maxParams,
    maxBatch: config.maxBatch ?? DEFAULT_LIMITS.maxBatch, holdTimeoutMs: config.holdTimeoutMs ?? DEFAULT_LIMITS.holdTimeoutMs,
  };
  const translate = (sql, params, dialectName) => baseTranslate(sql, params, dialectName, limits);
  const minDelay = backoff.minMs ?? 1000, maxDelay = backoff.maxMs ?? 30000;
  const drv = driver || (config.databaseConfigured ? createDriver(config) : null);
  const dialect = drv?.dialect ?? config.dialect ?? null;

  let ready = false, closed = false, probing = false, closing = null;
  let sleepTimer = null, wake = null;
  const waiters = new Set();
  const locks = new Map();

  const safeCall = (fn, ...args) => { try { fn?.(...args); } catch (error) { logger.error("ms-sql callback failed: " + (error?.code || error?.name || "error")); } };

  // ---------------------------------------------------------------- readiness
  function setReady() {
    if (ready || closed) return;
    ready = true;
    for (const waiter of [...waiters]) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(true); }
    safeCall(onReady, { dialect });
  }
  async function connectLoop() {
    if (probing || closed || !drv) return;
    probing = true;
    let delay = minDelay;
    try {
      while (!closed) {
        let step = "schema";
        try { await drv.init?.(); step = "connect"; await drv.ping(); setReady(); return; }
        catch (error) {
          if (closed) return;
          if (step === "schema") logger.error(`Cannot create or access schema "${config.schema}" (${mapError(dialect, error).kind}): grant CREATE on the database, or create the schema/database manually`);
          logger.warn(`Database unavailable (${mapError(dialect, error).kind}), retrying in ${Math.round(delay / 1000)}s`);
          await new Promise(resolve => { wake = resolve; sleepTimer = setTimer(() => { sleepTimer = null; wake = null; resolve(); }, delay); });
          delay = Math.min(delay * 2, maxDelay);
        }
      }
    } finally { probing = false; }
  }
  function markDown() {
    if (!ready || closed) return;
    ready = false;
    logger.warn("Database connection lost, reconnecting");
    safeCall(onDown);
    connectLoop();
  }
  const ensureReady = () => { if (!ready || closed) throw notReady(); };
  // Maps a driver error and flips the resource to "down" when the connection itself failed.
  function fail(error) {
    const mapped = mapError(dialect, error);
    if (mapped.kind === "CONNECTION") markDown();
    return mapped;
  }

  // ---------------------------------------------------------------- execution
  function logSlow(sql, started) {
    const elapsed = clock() - started;
    if (slowQueryMs > 0 && elapsed >= slowQueryMs) {
      const preview = sql.replace(/\s+/g, " ").trim().slice(0, SLOW_SQL_PREVIEW);
      logger.warn(`Slow query (${Math.round(elapsed)}ms): ${preview}`); // SQL text only, never values
    }
  }
  async function timed(sql, work) {
    const started = clock();
    try { return await work(); } finally { logSlow(sql, started); }
  }

  // Builds the seven query functions over a "run" strategy. `check` runs first (readiness or transaction
  // liveness), `run(translated, options, sql)` executes, `lease(fn)` gives fn a serial runner on one connection.
  function buildFunctions({ check, run, lease }) {
    const exec = async (sql, params, prepared) => { check(); return run(translate(sql, params, dialect), { prepared }, sql); };
    const rowsOf = result => Array.isArray(result) ? result : null;
    const query = (sql, params) => exec(sql, params, false);
    const single = async (sql, params) => rowsOf(await exec(sql, params, false))?.[0] ?? null;
    const scalar = async (sql, params) => {
      const row = await single(sql, params);
      if (!row) return null;
      const keys = Object.keys(row);
      return keys.length ? (row[keys[0]] ?? null) : null;
    };
    const insert = async (sql, params, options = {}) => {
      check();
      const column = options?.returning ?? "id";
      if (typeof column !== "string" || !RETURNING_COLUMN.test(column)) throw invalid("Invalid returning column name");
      let t = translate(sql, params, dialect);
      if (t.statement !== "INSERT") throw new SqlError("INSERT_REQUIRED", "insert() requires an INSERT statement");
      // The newline keeps the clause out of a trailing "--" comment.
      if (dialect === "postgres" && !t.hasReturning) t = { ...t, text: `${t.text}\nRETURNING "${column}"` };
      const result = await run(t, { prepared: false }, sql);
      if (Array.isArray(result)) {
        const row = result[0];
        if (!row) return null;
        const value = column in row ? row[column] : row[Object.keys(row)[0]];
        return value === undefined || value === null ? null : String(value);
      }
      return result.insertId ?? null;
    };
    const update = async (sql, params) => {
      const result = await exec(sql, params, false);
      return Array.isArray(result) ? result.length : result.affectedRows;
    };
    const prepare = (sql, params) => exec(sql, params, true);
    const rawExecute = async (sql, paramSets) => {
      check();
      if (!Array.isArray(paramSets)) throw invalid("rawExecute needs an array of parameter sets");
      if (paramSets.length > limits.maxBatch) throw invalid(`Batch too large (max ${limits.maxBatch})`);
      const prepared = paramSets.map(params => translate(sql, params, dialect)); // validate everything before touching the database
      if (!prepared.length) return [];
      return lease(async runner => {
        const results = [];
        for (const t of prepared) results.push(await runner(t, { prepared: true }, sql));
        return results;
      });
    };
    return { query, single, scalar, insert, update, prepare, rawExecute };
  }

  // Pool level: every call leases a connection for its own duration.
  const poolFunctions = buildFunctions({
    check: ensureReady,
    run: (t, options, sql) => timed(sql, async () => {
      try { return await drv.run(t.text, t.values, options); } catch (error) { throw fail(error); }
    }),
    async lease(fn) {
      let conn;
      try { conn = await drv.acquire(); } catch (error) { throw fail(error); }
      let broken = false;
      try {
        return await fn((t, options, sql) => timed(sql, async () => {
          try { return await conn.run(t.text, t.values, options); }
          catch (error) { const mapped = fail(error); broken = broken || mapped.kind === "CONNECTION"; throw mapped; }
        }));
      } finally { conn.release(broken); }
    },
  });

  // Session level: the functions handed to transaction() and withLock() callbacks, bound to one connection.
  function createSession(conn) {
    const state = { active: true, broken: false, released: false, expired: false };
    const check = () => { if (!state.active) throw new SqlError("OTHER", "Transaction or lock scope already finished"); };
    const connRun = (t, options, sql) => timed(sql, async () => {
      try { return await conn.run(t.text, t.values, options); }
      catch (error) { throw state.fail(error); }
    });
    // A client-side timeout leaves the statement running on the server (and pg/mysql2 queue the next command
    // behind it), so the connection must be discarded, exactly like a lost one.
    state.fail = error => { const mapped = fail(error); if (mapped.kind === "CONNECTION" || isClientTimeout(error)) state.broken = true; return mapped; };
    const functions = buildFunctions({ check, run: connRun, lease: fn => fn(connRun) });
    const api = Object.freeze({
      ...functions,
      transaction: async () => { throw new SqlError("OTHER", "Nested transactions are not supported"); },
    });
    // Releases the connection exactly once (the hold watchdog may have done it already).
    const release = () => { if (state.released) return; state.released = true; conn.release(state.broken); };
    // SEC-09: a scope may not keep its pooled connection longer than holdTimeoutMs. On expiry the scope is
    // dead (no more queries), the connection is destroyed (which also ends the transaction or the lock)
    // and `watch(work)` rejects with TIMEOUT even if `work` never settles.
    function watch(work) {
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimer(() => {
          state.expired = true; state.broken = true; state.active = false;
          logger.warn("Transaction or lock held its connection too long; connection destroyed");
          release();
          reject(new SqlError("TIMEOUT", "Transaction or lock exceeded the maximum hold time"));
        }, limits.holdTimeoutMs);
      });
      return Promise.race([work, expired]).finally(() => clearTimeout(timer));
    }
    return { api, state, release, watch, end() { state.active = false; } };
  }

  async function acquireSession() {
    ensureReady();
    let conn;
    try { conn = await drv.acquire(); } catch (error) { throw fail(error); }
    return { conn, session: createSession(conn) };
  }

  async function runTransaction(fn) {
    const { conn, session } = await acquireSession();
    let phase = "begin";
    try {
      return await session.watch((async () => {
        await conn.begin();
        phase = "fn";
        const value = await fn(session.api);
        session.end(); // the tx object is dead from here on, even while COMMIT is in flight
        phase = "commit";
        await conn.commit();
        phase = "done";
        return value;
      })());
    } catch (error) {
      session.end();
      const failure = session.state.expired || phase === "fn" ? error : session.state.fail(error); // errors from fn are rethrown untouched
      // A broken connection is destroyed on release (which ends the transaction); ROLLBACK would queue behind a hung statement.
      if (phase !== "done" && !session.state.broken) { try { await conn.rollback(); } catch { session.state.broken = true; } }
      throw failure;
    } finally { session.release(); }
  }

  async function transaction(arg) {
    if (typeof arg === "function") return runTransaction(arg);
    if (!Array.isArray(arg)) throw invalid("transaction needs a callback or an array of { query, values }");
    if (arg.length > limits.maxBatch) throw invalid(`Batch too large (max ${limits.maxBatch})`);
    ensureReady();
    const statements = arg.map(item => {
      if (!item || typeof item.query !== "string") throw invalid("Each transaction entry needs a query string");
      translate(item.query, item.values, dialect); // validate everything before BEGIN
      return { sql: item.query, values: item.values };
    });
    return runTransaction(async tx => {
      for (const { sql, values } of statements) await tx.query(sql, values);
      return true;
    });
  }

  async function withLock(name, fn, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
    if (typeof name !== "string" || !name || name.length > LOCK_NAME_MAX) throw invalid(`Lock name must be 1..${LOCK_NAME_MAX} characters`);
    if (typeof fn !== "function") throw invalid("withLock needs a callback");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw invalid("Invalid lock timeout");
    ensureReady();
    const deadline = Date.now() + timeoutMs;
    const timeoutError = () => new SqlError("TIMEOUT", "Could not acquire the lock in time");

    // In-process queue first: serializes holders of the same name inside this server regardless of the
    // engine's session semantics. The database lock then covers other processes.
    const previous = locks.get(name) || Promise.resolve();
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => mine);
    locks.set(name, tail);
    const cleanup = () => { release(); if (locks.get(name) === tail) locks.delete(name); };

    let held = null;
    try {
      if (!(await settledWithin(previous, timeoutMs, setTimer))) throw timeoutError();
      const { conn, session } = await acquireSession();
      held = { conn, session };
      return await session.watch((async () => {
        let got;
        try { got = await conn.lock(name, Math.max(0, deadline - Date.now())); }
        catch (error) { throw session.state.fail(error); }
        if (!got) throw timeoutError();
        held.locked = true;
        return fn(session.api);
      })());
    } finally {
      if (held) {
        held.session.end();
        if (held.locked && !held.session.state.broken) { try { await held.conn.unlock(name); } catch { held.session.state.broken = true; } }
        held.session.release();
      }
      cleanup();
    }
  }

  // ---------------------------------------------------------------- lifecycle
  function awaitConnection(timeoutMs) {
    if (closed || !configured) return Promise.reject(notReady());
    if (ready) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs !== undefined && timeoutMs !== null) {
        waiter.timer = setTimer(() => { waiters.delete(waiter); reject(new SqlError("TIMEOUT", "Timed out waiting for the database")); }, timeoutMs);
      }
      waiters.add(waiter);
    });
  }

  function close() {
    if (closing) return closing;
    closed = true; ready = false;
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
    wake?.(); wake = null;
    for (const waiter of [...waiters]) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.reject(notReady()); }
    closing = Promise.resolve().then(() => drv?.end()).catch(error => logger.error("ms-sql pool close failed: " + (error?.code || error?.name || "error")));
    return closing;
  }

  if (drv) connectLoop();

  return Object.freeze({
    dialect,
    schema: config.schema || null,
    ...poolFunctions,
    transaction, withLock,
    isReady: () => ready && !closed,
    awaitConnection,
    close,
  });
}

module.exports = { createSql, SqlError };
