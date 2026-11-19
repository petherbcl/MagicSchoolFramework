"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("../server/runtime");
const { loadConfig } = require("../server/config");

function host() {
  const handlers = {}, emitted = [], logs = [], exported = {};
  return {
    handlers, emitted, logs, exported,
    Events: { on: (name, fn) => { handlers[name] = fn; }, emit: (name, payload) => emitted.push([name, payload]), onClient() { throw new Error("no client events"); } },
    Exports: { register: (name, value) => { exported[name] = value; return true; } },
    console: { log: m => logs.push(["log", m]), warn: m => logs.push(["warn", m]), error: m => logs.push(["error", m]) },
  };
}
// Minimal createSql stand-in that records lifecycle and exposes the real owner shape.
function fakeCreate(state) {
  return opts => {
    state.opts = opts;
    state.closed = 0;
    return { dialect: "postgres", isReady: () => state.ready, query: async () => [], close: async () => { state.closed++; } };
  };
}

test("start: registers a frozen Sql view without close, forwards ready/down events", () => {
  const h = host(), state = {};
  start(h, { loadConfig: () => loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:secret@h/db" }, { envFile: null }), createSql: fakeCreate(state) });
  h.handlers.resourceStart("other");
  assert.equal(h.exported.Sql, undefined);
  h.handlers.resourceStart("ms-sql");
  assert.ok(Object.isFrozen(h.exported.Sql));
  assert.equal("close" in h.exported.Sql, false);
  assert.equal(typeof h.exported.Sql.query, "function");
  state.opts.onReady({ dialect: "postgres" });
  state.opts.onDown();
  assert.deepEqual(h.emitted, [["ms-sql:ready", { dialect: "postgres" }], ["ms-sql:down", undefined]]);
  assert.ok(h.logs.every(([, m]) => m.startsWith("[ms-sql] ") && !m.includes("secret")));
});

test("resourceStop closes the owner once and ignores other resources", async () => {
  const h = host(), state = {};
  start(h, { loadConfig: () => loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db" }, { envFile: null }), createSql: fakeCreate(state) });
  h.handlers.resourceStart("ms-sql");
  await h.handlers.resourceStop("other");
  assert.equal(state.closed, 0);
  await h.handlers.resourceStop("ms-sql");
  await h.handlers.resourceStop("ms-sql");
  assert.equal(state.closed, 1);
});

test("without MS_SQL_URL starts with a warning and isReady() is false (real createSql)", async () => {
  const h = host();
  start(h, { loadConfig: () => loadConfig({}, { envFile: null }) });
  h.handlers.resourceStart("ms-sql");
  assert.equal(h.exported.Sql.isReady(), false);
  assert.equal(h.exported.Sql.dialect, null);
  assert.ok(h.logs.some(([level, m]) => level === "warn" && m.startsWith("[ms-sql] MS_SQL_URL is not set")));
  await assert.rejects(h.exported.Sql.query("SELECT 1"), e => e.kind === "NOT_READY");
  await h.handlers.resourceStop("ms-sql");
});

test("invalid configuration is logged without the URL and aborts the start", () => {
  const h = host();
  start(h, { loadConfig: () => loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "http://u:topsecret@h/db" }, { envFile: null }) });
  assert.throws(() => h.handlers.resourceStart("ms-sql"), /MS_SQL_CONFIG_INVALID/);
  assert.equal(h.exported.Sql, undefined);
  assert.ok(h.logs.every(([, m]) => !m.includes("topsecret")));
});

test("failed export registration closes the pool and throws", () => {
  const h = host(), state = {};
  h.Exports.register = () => false;
  start(h, { loadConfig: () => loadConfig({}, { envFile: null }), createSql: fakeCreate(state) });
  assert.throws(() => h.handlers.resourceStart("ms-sql"), /EXPORT_REGISTRATION_FAILED/);
  assert.equal(state.closed, 1);
});

test("stop then start again (reload): a fresh Sql export, the old one is closed and cannot be reused", async () => {
  const { createSql } = require("../server");
  const { fakeDriver } = require("./helpers/fake-driver");
  const h = host(), exports = [];
  h.Exports.register = (name, value) => { exports.push(value); return true; };
  start(h, {
    loadConfig: () => loadConfig({ MS_SQL_SCHEMA: "ms_test", MS_SQL_URL: "postgres://u:p@h/db" }, { envFile: null }),
    createSql: opts => createSql({ ...opts, driver: fakeDriver(), backoff: { minMs: 5, maxMs: 20 } }),
  });
  h.handlers.resourceStart("ms-sql");
  await exports[0].awaitConnection(1000);
  assert.equal(exports[0].isReady(), true);
  await h.handlers.resourceStop("ms-sql");
  assert.equal(exports[0].isReady(), false);
  await assert.rejects(exports[0].query("SELECT 1"), error => error.kind === "NOT_READY");
  h.handlers.resourceStart("ms-sql");
  assert.equal(exports.length, 2);
  assert.notEqual(exports[0], exports[1]);
  await exports[1].awaitConnection(1000);
  assert.deepEqual(await exports[1].query("SELECT 1"), { affectedRows: 1, insertId: null, changedRows: 1 });
  await h.handlers.resourceStop("ms-sql");
});
