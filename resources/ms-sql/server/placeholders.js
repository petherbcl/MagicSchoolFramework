"use strict";

const { SqlError } = require("./errors");

const CACHE_LIMIT = 500;
const CACHE_MAX_SQL_LENGTH = 32768; // larger statements are parsed every time: the cache must not pin big texts
const DEFAULT_MAX_SQL_BYTES = 1048576, DEFAULT_MAX_PARAMS = 65535;
const cache = new Map();
const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

const invalid = message => new SqlError("INVALID_PARAMS", message);
const family = dialect => dialect === "postgres" ? "postgres" : "mysql";

// Single pass over the SQL. Literals, quoted identifiers, comments and dollar-quoted bodies are copied
// verbatim and never searched for placeholders. The same pass records the first keyword (statement type),
// a top-level RETURNING, and rejects a second statement.
function parse(sql, fam) {
  const pg = fam === "postgres";
  const n = sql.length;
  const out = [];
  const slots = []; // { name } or { name: null } per placeholder occurrence, in order
  let i = 0, depth = 0, statement = null, hasReturning = false, ended = false;
  const unterminated = () => new SqlError("SYNTAX", "Unterminated string, identifier or comment in SQL");
  const significant = () => { if (ended) throw invalid("Multiple statements are not allowed"); };

  while (i < n) {
    const c = sql[i], next = sql[i + 1];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { out.push(c); i++; continue; }
    // Comments (not significant tokens).
    // MySQL needs whitespace after "--"; PostgreSQL does not.
    const dashComment = c === "-" && next === "-" && (pg || i + 2 >= n || /[\s\x00-\x1f]/.test(sql[i + 2]));
    if (dashComment || (!pg && c === "#")) {
      let j = i; while (j < n && sql[j] !== "\n") j++;
      out.push(sql.slice(i, j)); i = j; continue;
    }
    if (c === "/" && next === "*") {
      // MySQL runs /*! ... */ and MariaDB /*M! ... */ as code, so they are not inert comments: reject them
      // before they can hide a second statement from this tokenizer (SEC-10).
      if (!pg && (sql[i + 2] === "!" || (sql[i + 2] === "M" && sql[i + 3] === "!"))) throw invalid("Executable comments (/*! */, /*M! */) are not allowed");
      let j = i + 2, level = 1;
      while (j < n && level > 0) {
        if (sql[j] === "*" && sql[j + 1] === "/") { level--; j += 2; }
        else if (pg && sql[j] === "/" && sql[j + 1] === "*") { level++; j += 2; }
        else j++;
      }
      if (level > 0) throw unterminated();
      out.push(sql.slice(i, j)); i = j; continue;
    }
    significant();
    if (c === "'" || c === '"' || (c === "`" && !pg)) {
      const backslash = !pg || (c === "'" && /[eE]/.test(sql[i - 1] || "") && !WORD_CHAR.test(sql[i - 2] || "")); // E'..' in PostgreSQL
      const escapes = c !== "`" && backslash;
      let j = i + 1, closed = false;
      while (j < n) {
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } closed = true; j++; break; }
        j++;
      }
      if (!closed) throw unterminated();
      out.push(sql.slice(i, j)); i = j; continue;
    }
    if (pg && c === "$" && !WORD_CHAR.test(sql[i - 1] || "")) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 130));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) throw unterminated();
        out.push(sql.slice(i, close + tag[0].length)); i = close + tag[0].length; continue;
      }
    }
    if (c === "?") { slots.push({ name: null }); out.push({ slot: slots.length - 1 }); i++; continue; }
    if (c === ":") {
      if (next === ":") { out.push("::"); i += 2; continue; } // cast
      if (next !== undefined && WORD_START.test(next) && next !== "$" && !WORD_CHAR.test(sql[i - 1] || "")) {
        let j = i + 1; while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
        slots.push({ name: sql.slice(i + 1, j) }); out.push({ slot: slots.length - 1 }); i = j; continue;
      }
      out.push(c); i++; continue;
    }
    if (c === ";") { ended = true; i++; continue; } // dropped: a trailing ';' must not break RETURNING appending
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (WORD_START.test(c) || (c >= "0" && c <= "9")) {
      let j = i; while (j < n && WORD_CHAR.test(sql[j])) j++;
      const word = sql.slice(i, j);
      if (statement === null && WORD_START.test(c)) statement = word.toUpperCase();
      if (depth === 0 && word.toUpperCase() === "RETURNING") hasReturning = true;
      out.push(word); i = j; continue;
    }
    out.push(c); i++;
  }

  const named = slots.filter(s => s.name !== null), positional = slots.length - named.length;
  if (named.length && positional) throw invalid("Cannot mix ? and :name placeholders in one query");
  const style = !slots.length ? "none" : named.length ? "named" : "positional";
  const names = [...new Set(named.map(s => s.name))];
  let text = "";
  if (pg) {
    let k = 0;
    for (const part of out) {
      if (typeof part === "string") text += part;
      else text += "$" + (style === "named" ? names.indexOf(slots[part.slot].name) + 1 : ++k);
    }
  } else {
    for (const part of out) text += typeof part === "string" ? part : "?";
  }
  return Object.freeze({ text, style, count: positional, names, occurrences: slots.map(s => s.name), statement, hasReturning, pg });
}

function template(sql, dialect, maxBytes = DEFAULT_MAX_SQL_BYTES) {
  if (typeof sql !== "string" || !sql.trim()) throw invalid("SQL must be a non-empty string");
  // length is a lower bound of the byte size (UTF-8 never shrinks it); only measure bytes when it matters.
  if (sql.length > maxBytes || (sql.length * 3 > maxBytes && Buffer.byteLength(sql) > maxBytes)) throw invalid(`SQL text too large (max ${maxBytes} bytes)`);
  const fam = family(dialect), key = fam + "\0" + sql;
  let t = cache.get(key);
  if (t) { cache.delete(key); cache.set(key, t); return t; } // refresh LRU position
  t = parse(sql, fam);
  if (sql.length > CACHE_MAX_SQL_LENGTH) return t;
  cache.set(key, t);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return t;
}

// undefined -> null; arrays and plain objects -> JSON text (same behaviour on every engine: no driver-side
// array/object expansion); bigint -> decimal string; functions and symbols are rejected.
function normalize(value) {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case "function": case "symbol": throw invalid("Unsupported parameter type");
    case "bigint": return value.toString();
    case "object":
      if (value instanceof Date || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
      try { return JSON.stringify(value); } catch { throw invalid("Parameter cannot be serialized to JSON"); }
    default: return value;
  }
}

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function bind(t, params) {
  const empty = params === undefined || params === null ||
    (Array.isArray(params) && params.length === 0) || (isPlainObject(params) && Object.keys(params).length === 0);
  if (t.style === "none") {
    if (!empty) throw invalid("Parameters supplied but the query has no placeholders");
    return [];
  }
  if (t.style === "positional") {
    if (!Array.isArray(params)) throw invalid("Positional (?) placeholders need an array of parameters");
    if (params.length !== t.count) throw invalid(`Expected ${t.count} parameters, received ${params.length}`);
    return params.map(normalize);
  }
  if (!isPlainObject(params)) throw invalid("Named (:name) placeholders need an object of parameters");
  for (const name of t.names) if (!Object.hasOwn(params, name)) throw invalid(`Missing parameter :${name}`);
  for (const key of Object.keys(params)) if (!t.names.includes(key)) throw invalid(`Unexpected parameter :${key}`);
  return (t.pg ? t.names : t.occurrences).map(name => normalize(params[name]));
}

function translate(sql, params, dialect, limits = {}) {
  const maxParams = limits.maxParams ?? DEFAULT_MAX_PARAMS;
  // Checked before parsing and before binding so oversized input never costs a full pass.
  if (Array.isArray(params) && params.length > maxParams) throw invalid(`Too many parameters (max ${maxParams})`);
  const t = template(sql, dialect, limits.maxSqlBytes);
  if (Math.max(t.count, t.names.length) > maxParams) throw invalid(`Too many parameters (max ${maxParams})`);
  return { text: t.text, values: bind(t, params), statement: t.statement, hasReturning: t.hasReturning };
}

module.exports = { translate, normalize, cacheSize: () => cache.size, clearCache: () => cache.clear() };
