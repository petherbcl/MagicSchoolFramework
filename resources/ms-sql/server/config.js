"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

const URL_PATTERN = /^(postgres(?:ql)?|mysql|mariadb):\/\//i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// Engine-owned namespaces: never a valid home for the application tables.
const RESERVED_SCHEMA = /^(pg_.*|information_schema|mysql|performance_schema|sys)$/i;
// URL parameter names (PostgreSQL and MySQL/MariaDB spellings) that ask for TLS. Matched by name, lowercase.
const TLS_URL_PARAMS = new Set(["ssl", "sslmode", "ssl-mode", "sslcert", "sslkey", "sslrootcert", "sslca", "sslcrl", "sslpassword", "ssl-ca", "ssl-cert", "ssl-key", "ssl-cipher"]);
const TLS_OFF_VALUES = new Set(["disable", "false", "0", "off", "no", "disabled"]);
const SCHEMA_ERROR = "Invalid MS_SQL_SCHEMA (required with MS_SQL_URL: letters, digits and underscore, not starting with a digit, at most 63 characters, not a system schema)";
const URL_ERROR = "MS_SQL_URL must be a PostgreSQL, MySQL or MariaDB connection string";

function readEnvFile(filename) {
  if (!filename) return {};
  try { return parseEnv(fs.readFileSync(filename, "utf8").replace(/^﻿/, "")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("MS_SQL_ENV_FILE_UNREADABLE");
  }
}

function integer(env, key, fallback, min, max) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

function boolean(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = String(env[key]).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${key}`);
}

// Dialect comes from the URL protocol. Error messages never echo the URL (it carries the password).
function parseUrl(raw) {
  const url = String(raw || "").trim();
  if (!url) return { url: "", dialect: null };
  const match = URL_PATTERN.exec(url);
  if (!match) throw new Error(URL_ERROR);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(URL_ERROR); }
  const protocol = match[1].toLowerCase();
  const host = decodeURIComponent(parsed.hostname.replace(/^\[|\]$/g, "")).toLowerCase();
  // Query string parameter NAMES only (values may carry secrets). The drivers ignore them (SEC-02).
  // TLS-requesting parameters, by NAME only. Values are read here just to skip explicit "no TLS" ones.
  const tlsUrlParams = [...new Set([...parsed.searchParams].filter(([key, value]) => {
    const name = key.toLowerCase();
    if (!TLS_URL_PARAMS.has(name)) return false;
    return !((name === "ssl" || name === "sslmode" || name === "ssl-mode") && TLS_OFF_VALUES.has(value.trim().toLowerCase()));
  }).map(([key]) => key))];
  return {
    url, dialect: protocol.startsWith("postgres") ? "postgres" : protocol,
    urlDatabase: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    hostLocal: LOCAL_HOSTS.has(host), ignoredUrlParams: [...new Set(parsed.searchParams.keys())], tlsUrlParams,
  };
}

// The schema name is interpolated (quoted) into DDL, so it is validated strictly here, once.
function parseSchema(env, configured) {
  const schema = String(env.MS_SQL_SCHEMA ?? "").trim();
  if (!schema) { if (configured) throw new Error(SCHEMA_ERROR); return ""; }
  if (!SCHEMA_PATTERN.test(schema) || RESERVED_SCHEMA.test(schema)) throw new Error(SCHEMA_ERROR);
  return schema;
}

// Reads the optional CA bundle once. Never echoes the path contents or the OS error in the message.
function readCa(file) {
  if (!file) return undefined;
  try {
    const pem = fs.readFileSync(path.resolve(file), "utf8");
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error();
    return pem;
  } catch { throw new Error("Invalid MS_SQL_SSL_CA (file missing, unreadable or not a PEM certificate)"); }
}

function loadConfig(env = process.env, options = {}) {
  // Explicit test environments stay isolated unless a file is requested.
  const envFile = options.envFile !== undefined ? options.envFile :
    env === process.env ? path.resolve(__dirname, "../.env") : null;
  // Never mutate process.env or replace values explicitly supplied by the host.
  env = { ...readEnvFile(envFile), ...env };
  const { url, dialect, urlDatabase = "", hostLocal = true, ignoredUrlParams = [], tlsUrlParams = [] } = parseUrl(env.MS_SQL_URL);
  const schema = parseSchema(env, Boolean(url));
  const ssl = boolean(env, "MS_SQL_SSL", false);
  const caFile = String(env.MS_SQL_SSL_CA || "").trim();
  if (caFile && !ssl) throw new Error("MS_SQL_SSL_CA requires MS_SQL_SSL=true");
  return Object.freeze({
    url, dialect, databaseConfigured: Boolean(url), schema,
    // MySQL/MariaDB: the schema IS the database, so a different name in the URL path is ignored (main.js warns).
    ignoredUrlDatabase: Boolean(url) && dialect !== "postgres" && Boolean(urlDatabase) && urlDatabase !== schema,
    poolSize: integer(env, "MS_SQL_POOL_SIZE", 5, 1, 20),
    queryTimeoutMs: integer(env, "MS_SQL_QUERY_TIMEOUT_MS", 10000, 100, 300000),
    slowQueryMs: integer(env, "MS_SQL_SLOW_QUERY_MS", 1000, 0, 600000),
    ssl, sslCa: readCa(caFile), hostLocal, ignoredUrlParams,
    // R-01: the URL asks for TLS but only MS_SQL_SSL turns it on, so runtime warns (names only).
    ignoredUrlTls: ssl ? [] : tlsUrlParams,
    // Hardening limits (SEC-09). Callers are trusted server code; these stop runaway SQL and hung scopes.
    maxSqlBytes: integer(env, "MS_SQL_MAX_SQL_BYTES", 1048576, 1024, 16777216),
    maxParams: integer(env, "MS_SQL_MAX_PARAMS", 65535, 1, 1000000),
    maxBatch: integer(env, "MS_SQL_MAX_BATCH", 10000, 1, 1000000),
    holdTimeoutMs: integer(env, "MS_SQL_HOLD_TIMEOUT_MS", 60000, 1000, 3600000),
  });
}

module.exports = { loadConfig };
