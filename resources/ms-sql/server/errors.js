"use strict";

const util = require("node:util");

const KINDS = Object.freeze(["UNIQUE_VIOLATION", "FOREIGN_KEY_VIOLATION", "DEADLOCK", "TIMEOUT", "CONNECTION",
  "SYNTAX", "INVALID_PARAMS", "INSERT_REQUIRED", "NOT_READY", "OTHER"]);

// SEC-07: the raw driver error (kept in `cause` for server-side diagnostics) carries parameter values:
// mysql2 `sql` (values interpolated) and `sqlMessage`, pg `detail`, `where`, `parameters`. These fields are
// made non-enumerable so util.inspect / console.error / JSON.stringify of the error or of its cause do not
// print them; code that reads them explicitly still can. The SqlError itself prints a redacted summary.
const SENSITIVE_FIELDS = ["sql", "sqlMessage", "detail", "where", "parameters", "values", "query", "internalQuery", "table", "column", "dataType"];
function redact(cause) {
  if (cause === null || typeof cause !== "object") return;
  for (const key of SENSITIVE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(cause, key);
    if (descriptor && descriptor.enumerable && descriptor.configurable) Object.defineProperty(cause, key, { ...descriptor, enumerable: false });
  }
}

// Normalized, engine independent error. The message is built from the kind only: driver messages can
// echo parameter values (e.g. MySQL "Duplicate entry '<value>'"), so the original error lives in `cause`.
class SqlError extends Error {
  constructor(kind, message, { constraint = null, sqlState = null, driverCode = null, cause } = {}) {
    super(message || `SQL error (${kind})`, cause === undefined ? undefined : { cause });
    redact(cause);
    this.name = "SqlError";
    this.code = "SQL_ERROR";
    this.kind = kind;
    this.constraint = constraint;
    this.sqlState = sqlState;
    this.driverCode = driverCode;
  }
}

// Printing a SqlError shows only the safe fields, never the cause (which the driver may have filled with values).
SqlError.prototype[util.inspect.custom] = function inspectSqlError() {
  return `SqlError [${this.kind}] ${this.message}`;
};
SqlError.prototype.toJSON = function toJSON() {
  return { name: this.name, code: this.code, kind: this.kind, message: this.message, constraint: this.constraint, sqlState: this.sqlState, driverCode: this.driverCode };
};

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "EAI_AGAIN", "ECONNABORTED", "CONNECTION_ENDED"]);
const PG_CONNECTION_MESSAGE = /connection terminated|not queryable|after calling end|timeout exceeded when trying to connect|connection (?:ended|closed)/i;

function describe(kind, constraint, sqlState, driverCode) {
  let text = `SQL error (${kind}`;
  const detail = driverCode || sqlState;
  if (detail && kind !== "UNIQUE_VIOLATION" && kind !== "FOREIGN_KEY_VIOLATION") text += `, ${detail}`;
  text += ")";
  if (constraint) text += ` on ${constraint}`;
  return text;
}

function mapPostgres(error) {
  const code = typeof error.code === "string" ? error.code : "";
  const sqlState = /^[0-9A-Z]{5}$/.test(code) ? code : null;
  let kind = "OTHER", constraint = null;
  if (code === "23505") { kind = "UNIQUE_VIOLATION"; constraint = error.constraint || null; }
  else if (code === "23503") { kind = "FOREIGN_KEY_VIOLATION"; constraint = error.constraint || null; }
  else if (code === "40P01" || code === "40001") kind = "DEADLOCK";
  else if (code === "57014") kind = "TIMEOUT";
  else if (code.startsWith("08") || ["57P01", "57P02", "57P03", "53300", "28000", "28P01"].includes(code) || NETWORK_CODES.has(code)) kind = "CONNECTION";
  else if (code.startsWith("42")) kind = "SYNTAX";
  else if (!code && /timeout/i.test(error.message || "")) kind = PG_CONNECTION_MESSAGE.test(error.message) ? "CONNECTION" : "TIMEOUT";
  else if (!code && PG_CONNECTION_MESSAGE.test(error.message || "")) kind = "CONNECTION";
  return { kind, constraint, sqlState, driverCode: code || null };
}

// MySQL: "Duplicate entry 'v' for key 'tbl.idx'" (8.0.19+) or "... for key 'idx'" (MariaDB). The key is the
// last quoted group; the table prefix is dropped. The duplicated value is never copied anywhere.
function mysqlConstraint(error, kind) {
  const message = String(error.sqlMessage || error.message || "");
  if (kind === "UNIQUE_VIOLATION") {
    const match = /for key '([^']*)'\s*$/.exec(message);
    return match ? match[1].split(".").pop() : null;
  }
  const match = /CONSTRAINT `([^`]+)`/.exec(message);
  return match ? match[1] : null;
}

function mapMysql(error) {
  const errno = Number.isInteger(error.errno) ? error.errno : null;
  const code = typeof error.code === "string" ? error.code : "";
  const sqlState = typeof error.sqlState === "string" && error.sqlState ? error.sqlState : null;
  const driverCode = code || (errno === null ? null : String(errno));
  let kind = "OTHER";
  if (errno === 1062) kind = "UNIQUE_VIOLATION";
  else if (errno === 1451 || errno === 1452) kind = "FOREIGN_KEY_VIOLATION";
  else if (errno === 1213) kind = "DEADLOCK";
  else if (errno === 3024 || errno === 1205 || errno === 1969 || code === "PROTOCOL_SEQUENCE_TIMEOUT" || code === "POOL_ACQUIRE_TIMEOUT") kind = "TIMEOUT";
  else if (errno === 1064 || (sqlState && sqlState.startsWith("42"))) kind = "SYNTAX";
  else if (NETWORK_CODES.has(code) || code === "PROTOCOL_CONNECTION_LOST" || code === "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR" ||
    code === "POOL_CLOSED" || [1040, 1045, 2002, 2003, 2006, 2013].includes(errno) || (error.fatal === true && errno === null)) kind = "CONNECTION";
  const constraint = kind === "UNIQUE_VIOLATION" || kind === "FOREIGN_KEY_VIOLATION" ? mysqlConstraint(error, kind) : null;
  return { kind, constraint, sqlState, driverCode };
}

function mapError(dialect, error) {
  if (error instanceof SqlError) return error;
  if (!error || typeof error !== "object") return new SqlError("OTHER", undefined, { cause: error });
  const m = dialect === "postgres" ? mapPostgres(error) : mapMysql(error);
  return new SqlError(m.kind, describe(m.kind, m.constraint, m.sqlState, m.driverCode),
    { constraint: m.constraint, sqlState: m.sqlState, driverCode: m.driverCode, cause: error });
}

module.exports = { SqlError, mapError, KINDS };
