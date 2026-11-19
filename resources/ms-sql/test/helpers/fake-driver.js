"use strict";

// Scriptable in-memory driver for the state-machine tests of createSql (readiness, transactions, locks).
// `state.down` makes ping/acquire/run fail like a dead database; `state.results` queues query results;
// `state.fail` is a function (text) => Error | undefined that can fail specific statements.
function fakeDriver({ dialect = "postgres" } = {}) {
  const state = { initFail: null, inits: 0, down: false, results: [], fail: null, log: [], pings: 0, ended: 0, released: [], active: 0, maxActive: 0, runDelay: 0 };
  const dead = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const header = { affectedRows: 1, insertId: null, changedRows: 1 };
  async function exec(label, text, values, options) {
    if (state.down) throw dead();
    state.log.push({ label, text, values, options });
    if (state.runDelay) await new Promise(resolve => setTimeout(resolve, state.runDelay));
    const error = state.fail?.(text);
    if (error) throw error;
    return state.results.length ? state.results.shift() : header;
  }
  const driver = {
    dialect, state,
    async init() { state.inits++; if (state.initFail) throw state.initFail; },
    async ping() { state.pings++; if (state.down) throw dead(); },
    run: (text, values, options) => exec("pool", text, values, options),
    async acquire() {
      if (state.down) throw dead();
      const id = state.released.length + state.active + 1;
      state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      const lockHeld = [];
      return {
        id,
        run: (text, values, options) => exec("conn", text, values, options),
        async begin() { state.log.push({ label: "begin" }); if (state.down) throw dead(); },
        async commit() { state.log.push({ label: "commit" }); const e = state.failCommit; if (e) throw e; if (state.down) throw dead(); },
        async rollback() { state.log.push({ label: "rollback" }); if (state.down) throw dead(); },
        async lock(name, timeoutMs) { state.log.push({ label: "lock", name, timeoutMs }); if (state.denyLock) return false; lockHeld.push(name); return true; },
        async unlock(name) { state.log.push({ label: "unlock", name }); },
        release(broken) { state.active--; state.released.push({ id, broken: Boolean(broken) }); },
      };
    },
    async end() { state.ended++; },
  };
  return driver;
}

const labels = state => state.log.map(entry => entry.label);

module.exports = { fakeDriver, labels };
