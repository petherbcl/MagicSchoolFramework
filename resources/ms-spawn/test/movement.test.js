"use strict";
// CHG-01 (stories 02.07 to 02.10): teleport and re-hold on select, hold takeover, races, failures, confirm gate.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpawn } = require("../server/spawn");
const { loadConfig } = require("../server/config");

const LOCATIONS = [
  { name: "Hogsmeade", x: 1000, y: 2000, z: 300, yaw: 90 },
  { name: "Pátio de Hogwarts", x: -50.5, y: 60, z: 7, yaw: -16.3 },
];
// CHG-05: every configured location needs a camera. The default test camera is 100/200/30 cm away from the spawn point so a test
// can tell the camera position (preview target) from the spawn point (confirm destination).
const withCamera = l => (l.camera ? l : { ...l, camera: { x: l.x + 100, y: l.y + 200, z: l.z + 30 } });
const LAST = { x: 11, y: 22, z: 33, yaw: 44 };
const FLIGHT = 1300;
const OK = { result: "ok", status: 0 };

// `gap` is the SEC-06 minimum interval between native moves; the CHG-01 tests run with 0 (they test ordering, not pacing).
function fixture({ locations = LOCATIONS, notices = { TELEPORT_FAILED: "falha" }, gap = 0, config: overrides = {} } = {}) {
  let now = 1000000;
  const config = { ...loadConfig({ MS_SPAWN_LOCATIONS: JSON.stringify(locations.map(withCamera)) }, { envFile: null }), moveGapMs: gap, ...overrides };
  // Fake timers driven by the fake clock: advance() runs the timers that fell due.
  const timerQueue = [];
  const timers = { setTimeout: (fn, ms) => { const timer = { fn, due: now + ms }; timerQueue.push(timer); return timer; },
    clearTimeout: timer => { const i = timerQueue.indexOf(timer); if (i >= 0) timerQueue.splice(i, 1); } };
  const sessions = new Map(), events = [], states = [];
  const core = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.get(id)?.ready === true } };
  // Fake native player: hold ownership is modelled so tests can prove the player is never unheld by a takeover.
  const native = { holders: new Set(["lobby"]), log: [], teleports: [], options: [], opens: [], logs: [], releases: 0, active: 0, maxActive: 0, auto: true, takeoverOk: true, throwTeleport: false, holdOk: true };
  const game = {
    open(id, payload) { native.opens.push(payload); }, state: (id, payload) => states.push({ id, payload }),
    takeover() { native.log.push("takeover"); if (!native.takeoverOk) return false; native.holders.add("preview"); native.log.push("hold:preview"); native.holders.delete("lobby"); native.log.push("release:lobby"); return true; },
    hold(id, point) { native.log.push("hold:" + (point ? point.x + "," + point.y : "here")); if (!native.holdOk) return false; native.holders.add("preview"); return true; },
    release() { native.log.push("release:preview"); native.releases++; native.holders.delete("preview"); },
    teleport(id, point, options) {
      native.options.push(options);
      native.log.push("teleport:" + point.x + "," + point.y);
      if (native.throwTeleport) throw new Error("native");
      const entry = { point, done: false }; native.teleports.push(entry);
      native.active += 1; native.maxActive = Math.max(native.maxActive, native.active);
      return new Promise(resolve => {
        entry.resolve = result => { if (!entry.done) { entry.done = true; native.active -= 1; resolve(result); } };
        if (native.auto) entry.resolve(OK);
      });
    },
    // The adapter contract: cancelling (or a newer teleport) resolves the pending one as "replaced".
    cancelTeleport() { native.log.push("cancel"); const last = native.teleports.at(-1); if (last && !last.done) last.resolve({ result: "replaced", status: 1 }); },
  };
  const spawn = createSpawn({ config, game, core, notices, clock: () => now, timers, emit: (name, payload) => events.push({ name, payload }), logger: { error() {}, log: line => native.logs.push(line) } });
  spawn.start();
  const join = (id = 1, sessionId = "s" + id) => sessions.set(id, { sessionId, userId: "1", ready: true });
  const req = (id = 1, last = null) => spawn.request({ playerId: id, sessionId: "s" + id, userId: "1", characterId: "7", last });
  const f = { spawn, events, states, native, join, req, config,
    names: () => events.map(e => e.name),
    lastState: id => states.filter(s => s.id === id).at(-1)?.payload,
    advance: ms => { now += ms; for (const timer of [...timerQueue]) if (timer.due <= now) { timerQueue.splice(timerQueue.indexOf(timer), 1); timer.fn(); } },
    timers: timerQueue,
    settle: () => new Promise(resolve => setImmediate(resolve)) };
  return f;
}
const reject = (fn, code) => assert.throws(fn, { name: "SpawnError", code });
const ready = async (f, id) => { f.spawn.select(1, { id }); await f.settle(); f.advance(FLIGHT); f.spawn.arrived(1, { id }); f.advance(500); };
const started = async (settings, { auto = true } = {}) => { const f = fixture(settings); f.join(); f.req(1); f.native.auto = auto; return f; };

test("02.07: a valid select releases the hold, teleports to the configured point, then holds there; state stays choosing", async () => {
  const f = await started();
  f.spawn.select(1, { id: "patio-de-hogwarts", x: 9, y: 9, z: 9, yaw: 9 }); await f.settle();
  assert.deepEqual(f.native.log, ["takeover", "hold:preview", "release:lobby", "release:preview", "teleport:49.5,260", "hold:49.5,260"]);
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "patio-de-hogwarts", teleport: "done" });
  assert.deepEqual([...f.native.holders], ["preview"]);
  assert.equal(f.events.length, 0);
});
test("02.07: selecting last teleports to the stored Overland position", async () => {
  const f = fixture(); f.join(); f.req(1, LAST);
  f.spawn.select(1, { id: "last" }); await f.settle();
  assert.ok(f.native.log.includes("teleport:11,22")); assert.equal(f.native.log.at(-1), "hold:11,22");
});
test("02.08: the new hold goes on before the lobby hold is released, once per selection", async () => {
  const f = await started();
  assert.deepEqual([...f.native.holders], ["lobby"]);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  const log = f.native.log;
  assert.ok(log.indexOf("hold:preview") < log.indexOf("release:lobby"));
  f.advance(500); f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  assert.equal(log.filter(entry => entry === "takeover").length, 1);
});
test("02.08: a refused takeover leaves the lobby hold alone, keeps the selection, notifies, and is retried", async () => {
  const f = await started(); f.native.takeoverOk = false;
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.deepEqual([...f.native.holders], ["lobby"]); assert.equal(f.native.teleports.length, 0); assert.equal(f.native.releases, 0);
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "failed", notice: "falha" });
  assert.deepEqual(f.events, []);
  f.native.takeoverOk = true; f.advance(500); f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.deepEqual([...f.native.holders], ["preview"]);
});
test("02.07: rapid selects A, B, C never run teleports in parallel and only the last one updates state", async () => {
  const f = await started({ locations: [...LOCATIONS, { name: "C", x: 7, y: 8, z: 9, yaw: 0 }] }, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); f.advance(250);
  f.spawn.select(1, { id: "patio-de-hogwarts" }); f.advance(250);
  f.spawn.select(1, { id: "c" }); await f.settle();
  assert.equal(f.native.maxActive, 1); assert.equal(f.native.teleports.length, 3);
  assert.deepEqual(f.native.teleports.map(e => e.done), [true, true, false]);
  f.native.teleports[2].resolve(OK); await f.settle();
  assert.equal(f.native.log.at(-1), "hold:107,208");
  assert.equal(f.native.log.filter(entry => entry.startsWith("hold:") && entry !== "hold:preview").length, 1);
  assert.equal(f.lastState(1).selectedId, "c"); assert.equal(f.spawn.api.holds(1, "s1"), true);
});
test("02.07: a replaced teleport (status 1) of an older select is ignored: no notice, no hold", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.advance(250); f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  f.native.teleports[0].resolve({ result: "replaced", status: 1 }); await f.settle();
  assert.deepEqual(f.states.filter(s => s.payload.notice), []);
  assert.equal(f.native.log.includes("hold:1100,2200"), false);
  f.native.teleports[1].resolve(OK); await f.settle();
  assert.equal(f.native.log.at(-1), "hold:49.5,260");
});
test("02.07: a select flood is dropped without extra teleports", async () => {
  const f = await started();
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  for (let i = 0; i < 200; i++) { try { f.spawn.select(1, { id: i % 2 ? "hogsmeade" : "patio-de-hogwarts" }); } catch { /* rate limited or dropped */ } }
  await f.settle();
  assert.equal(f.native.teleports.length, 1);
});
test("A1: re-selecting the id already stood at restarts the gate without a new teleport", async () => {
  const f = await started();
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(FLIGHT); f.spawn.arrived(1, { id: "hogsmeade" });
  f.advance(500); f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.native.teleports.length, 1);
  f.advance(500); reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED"); // arrival reset by the new select
});
test("A1: re-selecting the id of a pending teleport does not restart it; a failed move is retried", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(250); f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.native.teleports.length, 1);
  f.native.teleports[0].resolve({ result: "failed", status: 4 }); await f.settle();
  f.advance(250); f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.native.teleports.length, 2);
});

for (const [name, result] of [["status 2", { result: "failed", status: 2 }], ["status 3", { result: "failed", status: 3 }], ["status 4", { result: "failed", status: 4 }],
  ["status 5", { result: "failed", status: 5 }], ["timeout", { result: "timeout" }], ["a foreign replaced", { result: "replaced", status: 1 }]]) {
  test("02.09: teleport failure (" + name + ") keeps the selection, notifies, holds the player and never cancels", async () => {
    const f = await started(undefined, { auto: false });
    f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
    f.native.teleports[0].resolve(result); await f.settle();
    assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "failed", notice: "falha" });
    assert.deepEqual(f.events, []);
    assert.deepEqual([...f.native.holders], ["preview"]); assert.equal(f.native.log.at(-1), "hold:here");
    f.advance(FLIGHT); f.spawn.arrived(1, { id: "hogsmeade" }); f.advance(500); // arrival opens the gate after a failure
    f.spawn.confirm(1, { id: "hogsmeade" });
    assert.equal(f.names().at(-1), "ms:spawnSelected");
  });
}
test("02.09: after a failure the player is re-held at the last held point", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.native.teleports[0].resolve(OK); await f.settle();
  f.advance(250); f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  f.native.teleports[1].resolve({ result: "failed", status: 4 }); await f.settle();
  assert.equal(f.native.log.at(-1), "hold:1100,2200");
});
test("02.09: an adapter exception is a failure, the next select retries; a late stale failure is silent", async () => {
  const f = await started(); f.native.throwTeleport = true;
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.lastState(1).notice, "falha"); assert.deepEqual([...f.native.holders], ["preview"]);
  f.native.throwTeleport = false; f.advance(250); f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  assert.equal(f.native.log.at(-1), "hold:49.5,260");
  const g = await started(undefined, { auto: false });
  g.spawn.select(1, { id: "hogsmeade" }); await g.settle(); g.advance(250); g.spawn.select(1, { id: "patio-de-hogwarts" }); await g.settle();
  g.native.teleports[0].resolve({ result: "failed", status: 4 }); await g.settle();
  assert.equal(g.states.filter(s => s.payload.notice).length, 0);
});
test("02.09: without a notice text the failure is silent but keeps the selection", async () => {
  const f = await started(undefined, { auto: false }); // fixture with notices
  const q = fixture({ notices: {} }); q.join(); q.req(1); q.native.takeoverOk = false;
  q.spawn.select(1, { id: "hogsmeade" }); await q.settle();
  assert.equal(q.states.some(s => s.payload.notice), false); assert.equal(q.lastState(1).selectedId, "hogsmeade");
  assert.ok(f);
});

test("02.10: confirm with a pending teleport is rejected (NOT_ARRIVED) even after arrival and the timer, then accepted once it completes", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.advance(FLIGHT); f.spawn.arrived(1, { id: "hogsmeade" }); f.advance(9000);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED");
  assert.equal(f.lastState(1).status, "choosing"); assert.equal(f.names().includes("ms:spawnSelected"), false);
  f.native.teleports[0].resolve(OK); await f.settle(); f.advance(300);
  f.spawn.confirm(1, { id: "hogsmeade" });
  assert.deepEqual(f.events.at(-1).payload.destination, { x: 1000, y: 2000, z: 300, yaw: 90 });
});
test("02.10: the gate is relative to the last select: a completed A does not count while B is pending", async () => {
  const f = await started();
  await ready(f, "hogsmeade"); f.native.auto = false;
  f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle(); f.advance(FLIGHT); f.spawn.arrived(1, { id: "patio-de-hogwarts" }); f.advance(500);
  reject(() => f.spawn.confirm(1, { id: "patio-de-hogwarts" }), "NOT_ARRIVED");
  f.native.teleports.at(-1).resolve(OK); await f.settle(); f.advance(300);
  f.spawn.confirm(1, { id: "patio-de-hogwarts" });
  assert.equal(f.events.length, 1);
});
test("02.10: the client's area-loaded report is not an input: extra fields never open the gate", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade", areaLoaded: true }); await f.settle(); f.advance(FLIGHT);
  f.spawn.arrived(1, { id: "hogsmeade", areaLoaded: true }); f.advance(500);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade", areaLoaded: true }), "NOT_ARRIVED");
});

// Exit paths: the preview hold is released exactly once and nothing stays pending for the player.
const held = async () => { const f = await started(); f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); assert.deepEqual([...f.native.holders], ["preview"]); f.native.releases = 0; return f; };
const clean = (f, releases = 1) => { assert.equal(f.native.releases, releases); assert.equal(f.native.holders.has("preview"), false); assert.equal(f.spawn.guard(1)(), false); };
test("02.08: confirm releases the preview hold before ms:spawnSelected, once; later closes do not release again", async () => {
  const f = await held(); f.advance(FLIGHT); f.spawn.arrived(1, { id: "hogsmeade" }); f.advance(500);
  f.spawn.confirm(1, { id: "hogsmeade" });
  assert.equal(f.native.releases, 1); assert.equal(f.names().at(-1), "ms:spawnSelected");
  f.spawn.characterReady({ playerId: 1, sessionId: "s1" }); f.spawn.sessionEnded("s1"); f.spawn.disconnect(1);
  clean(f);
});
test("02.08: session end and disconnect release exactly once and emit nothing", async () => {
  let f = await held(); f.spawn.sessionEnded("s1"); f.spawn.sessionEnded("s1"); clean(f); assert.deepEqual(f.events, []);
  f = await held(); f.spawn.disconnect(1); f.spawn.disconnect(1); clean(f); assert.deepEqual(f.events, []);
});
test("02.08: abort, stop and the watchdog release exactly once with their cancel reason", async () => {
  let f = await held(); f.spawn.abort(1); clean(f); assert.equal(f.events[0].payload.reason, "INTERNAL_ERROR");
  f = await held(); f.spawn.stop(); clean(f); assert.equal(f.events[0].payload.reason, "STOPPED");
  f = await held(); f.advance(31000); f.spawn.tick(); f.spawn.tick(); clean(f); assert.equal(f.events[0].payload.reason, "CLIENT_TIMEOUT");
});
test("02.08: NOT_READY and NO_OPTIONS happen before any hold is taken: nothing is released, the lobby hold stays", () => {
  const f = fixture({ locations: [] }); f.join(); f.req(1);
  assert.equal(f.events[0].payload.reason, "NO_OPTIONS"); assert.deepEqual([...f.native.holders], ["lobby"]); assert.equal(f.native.releases, 0);
  const g = fixture(); g.join(); g.spawn.stop(); g.req(1);
  assert.equal(g.events[0].payload.reason, "NOT_READY"); assert.deepEqual([...g.native.holders], ["lobby"]); assert.equal(g.native.releases, 0);
});
test("02.08: an exit with a teleport pending cancels it, ignores the late result and leaves no ms-spawn hold", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.spawn.sessionEnded("s1");
  assert.ok(f.native.log.includes("cancel"));
  f.native.teleports[0].resolve(OK); await f.settle();
  assert.equal(f.native.log.includes("hold:1100,2200"), false); assert.equal(f.native.holders.has("preview"), false);
  // a reused playerId with a new session is not affected by the old result either
  const g = await started(undefined, { auto: false });
  g.spawn.select(1, { id: "hogsmeade" }); await g.settle();
  g.join(1, "other"); g.native.teleports[0].resolve(OK); await g.settle();
  assert.equal(g.native.log.includes("hold:1100,2200"), false);
});
test("02.08: a replacing request hands the hold over without releasing it", async () => {
  const f = await held(); f.req(1);
  assert.equal(f.native.releases, 0); assert.deepEqual([...f.native.holders], ["preview"]);
  f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  assert.equal(f.native.log.filter(entry => entry === "takeover").length, 1);
  f.spawn.abort(1); clean(f, 2); // the select's own release before the teleport, then the final one
});

// ---- Security remediation (docs/security-audit-ms-spawn.md section 8): SEC-06 .. SEC-10 ----
const tickFor = async (f, ms, step = 5000) => { for (let t = 0; t < ms; t += step) { f.advance(step); f.spawn.tick(); await f.settle(); } };

test("SEC-06: the minimum interval queues a trailing move, the latest select wins", async () => {
  const f = await started({ gap: 1500, locations: [...LOCATIONS, { name: "C", x: 7, y: 8, z: 9, yaw: 0 }] });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.advance(250); f.spawn.select(1, { id: "patio-de-hogwarts" }); f.advance(250); f.spawn.select(1, { id: "c" }); await f.settle();
  assert.equal(f.native.teleports.length, 1, "no native move inside the gap");
  f.advance(250); reject(() => f.spawn.confirm(1, { id: "c" }), "NOT_ARRIVED"); // a queued move counts as pending
  f.advance(1500); await f.settle();
  assert.deepEqual(f.native.teleports.map(e => e.point.x), [1100, 107]);
  assert.equal(f.native.log.at(-1), "hold:107,208"); assert.equal(f.lastState(1).selectedId, "c");
});
test("SEC-06: 1000 alternating selects start at most the capped number of teleports, then notice and stay held", async () => {
  const f = await started({ gap: 1500 }); f.spawn.opened(1);
  let limited = 0; const errs = {};
  for (let i = 0; i < 1000; i++) {
    f.advance(250);
    try { f.spawn.select(1, { id: i % 2 ? "hogsmeade" : "patio-de-hogwarts" }); } catch (error) { if (error.code === "MOVE_LIMIT") limited++; else errs[error.code] = (errs[error.code] || 0) + 1; }
    await f.settle();
  }
  f.advance(1500); await f.settle();
  assert.ok(f.native.teleports.length <= f.config.maxMoves, "teleports " + f.native.teleports.length);
  assert.ok(limited >= 480, JSON.stringify(errs) + limited); // the id already stood at is never a new move assert.equal(f.timers.length, 0);
  assert.deepEqual([...f.native.holders], ["preview"]); assert.equal(f.spawn.api.holds(1, "s1"), true);
});
test("SEC-06: the unheld window is bounded: a selection stuck unheld is cancelled to the default spawn", async () => {
  const f = await started(undefined, { auto: false }); f.spawn.opened(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.native.holders.has("preview"), false);
  f.advance(30000); f.spawn.tick(); assert.deepEqual(f.events, []); // still inside the bound (a slow teleport is not cut)
  f.advance(10000); f.spawn.tick();
  assert.equal(f.names().at(-1), "ms:spawnCancelled"); assert.equal(f.events.at(-1).payload.reason, "INTERNAL_ERROR");
  assert.equal(f.spawn.guard(1)(), false);
});
test("SEC-06: a selection that is held again is not cancelled by the unheld bound", async () => {
  const f = await started(undefined, { auto: false }); f.spawn.opened(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(20000);
  f.native.teleports[0].resolve(OK); await f.settle(); await tickFor(f, 120000);
  assert.deepEqual(f.events, []); assert.equal(f.spawn.api.holds(1, "s1"), true);
});

test("SEC-08: 24 h of idle keeps the player held (renewals observed) and the selection open; stop ends the renewals", async () => {
  const f = await started(); f.spawn.opened(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  const holds = () => f.native.log.filter(entry => entry === "hold:1100,2200").length;
  assert.equal(holds(), 1);
  await tickFor(f, 24 * 3600 * 1000, 60000);
  assert.ok(holds() >= 140 && holds() <= 150, "renewals " + holds());
  assert.deepEqual([...f.native.holders], ["preview"]); assert.equal(f.spawn.api.holds(1, "s1"), true); assert.deepEqual(f.events, []);
  f.spawn.stop(); const after = holds(); f.advance(3600000); f.spawn.tick();
  assert.equal(holds(), after); assert.equal(f.native.holders.has("preview"), false);
});
test("SEC-08: a failed renewal ends the selection (default spawn) instead of leaving a stale holding flag", async () => {
  const f = await started(); f.spawn.opened(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.native.holdOk = false; await tickFor(f, 11 * 60 * 1000, 60000);
  assert.equal(f.events.at(-1).payload.reason, "INTERNAL_ERROR"); assert.equal(f.spawn.guard(1)(), false);
});

test("SEC-09: a refused hold after a successful teleport cancels the selection with INTERNAL_ERROR", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.native.holdOk = false; f.native.teleports[0].resolve(OK); await f.settle();
  assert.equal(f.names().at(-1), "ms:spawnCancelled"); assert.equal(f.events.at(-1).payload.reason, "INTERNAL_ERROR");
  assert.equal(f.spawn.guard(1)(), false);
});
test("SEC-09: a refused re-hold after a failed teleport cancels the selection", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.native.holdOk = false; f.native.teleports[0].resolve({ result: "failed", status: 4 }); await f.settle();
  assert.equal(f.events.at(-1).payload.reason, "INTERNAL_ERROR");
});
test("SEC-09: a selection replaced mid-teleport ends up held; if that hold is refused it is cancelled", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.native.holders.has("preview"), false);
  f.req(1); await f.settle();
  assert.deepEqual([...f.native.holders], ["preview"]); assert.equal(f.spawn.api.holds(1, "s1"), true); assert.deepEqual(f.events, []);
  const g = await started(undefined, { auto: false });
  g.spawn.select(1, { id: "hogsmeade" }); await g.settle();
  g.native.holdOk = false; g.req(1);
  assert.equal(g.events.at(-1).payload.reason, "INTERNAL_ERROR"); assert.equal(g.spawn.guard(1)(), false);
});

test("SEC-10: aborting with a teleport pending falls back to the default at once and the late landing changes nothing", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.spawn.abort(1, "CLIENT_TIMEOUT");
  assert.equal(f.events.length, 1); assert.equal(f.events[0].payload.reason, "CLIENT_TIMEOUT");
  const statesBefore = f.states.length;
  f.native.teleports[0].resolve(OK); await f.settle();
  assert.equal(f.native.log.includes("hold:1100,2200"), false); assert.equal(f.native.holders.has("preview"), false);
  assert.equal(f.events.length, 1); assert.equal(f.states.length, statesBefore);
});

// ---- CHG-02 story 02.12: teleport result signal (G14) ------------------------------------------------------------------
test("02.12: a teleport that completes is signalled once as teleport 'done' with the select id and no coordinates", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.lastState(1).teleport, undefined);
  f.native.teleports[0].resolve(OK); await f.settle();
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  assert.equal(JSON.stringify(f.lastState(1)).match(/"[xyz]"|yaw/), null);
  assert.equal(f.states.filter(s => s.payload.teleport === "done").length, 1);
});
test("02.12: a superseded select never signals; only the latest select's result does", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(250);
  f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  assert.equal(f.states.filter(s => s.payload.teleport).length, 0); // A resolved "replaced" (status 1): nothing for A
  f.native.teleports.at(-1).resolve(OK); await f.settle();
  const signals = f.states.filter(s => s.payload.teleport);
  assert.deepEqual(signals.map(s => [s.payload.selectedId, s.payload.teleport]), [["patio-de-hogwarts", "done"]]);
});
test("02.12: re-selecting the id whose teleport already finished repeats 'done' at once (no new move will signal it)", async () => {
  const f = await started();
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.states.length = 0;
  f.advance(500); f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.deepEqual(f.states.map(s => s.payload), [{ status: "choosing", selectedId: "hogsmeade", teleport: "done" }]);
  assert.equal(f.native.teleports.length, 1);
});
test("02.12: a failure never kicks or cancels, and a later notice repeats the finished move's result (SEC-14)", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.native.teleports[0].resolve({ result: "failed", status: 3 }); await f.settle();
  assert.equal(f.lastState(1).teleport, "failed"); assert.deepEqual(f.events, []);
  f.advance(3000); f.spawn.notify(1, "outro", "X");
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "failed", notice: "outro" });
});
test("02.12: the confirm gate ignores the signal: only the arrival report or the timer decide", async () => {
  const f = await started();
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(500);
  assert.equal(f.lastState(1).teleport, "done");
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED");
});

// ---- Section 9 re-gate (SEC-12, SEC-13, SEC-14) -------------------------------------------------------------------------
test("SEC-13: a refused re-hold of a carried-over selection tells the player (state closed) and cancels with INTERNAL_ERROR", async () => {
  const g = await started(undefined, { auto: false });
  g.spawn.select(1, { id: "hogsmeade" }); await g.settle();
  const before = g.states.length;
  g.native.holdOk = false; g.req(1);
  const closed = g.states.slice(before).filter(s => s.id === 1 && s.payload.status === "closed");
  assert.equal(closed.length, 1, "the page of the replaced selection must get status closed");
  assert.equal(g.events.at(-1).payload.reason, "INTERNAL_ERROR"); assert.equal(g.spawn.guard(1)(), false);
});
test("SEC-14: a notice repeats the result of the finished move (done) so a restarted client does not wait for it", async () => {
  const f = await started(); f.spawn.opened(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.advance(3000); f.spawn.notify(1, "x", "MOVE_LIMIT");
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "done", notice: "x" });
});
test("SEC-14: no teleport result is attached while the move is pending or nothing is selected", async () => {
  const f = await started(undefined, { auto: false }); f.spawn.opened(1);
  f.spawn.notify(1, "a", "A"); assert.deepEqual(f.lastState(1), { status: "choosing", notice: "a" });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.advance(3000); f.spawn.notify(1, "x", "B");
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", notice: "x" });
});
test("SEC-14: after a real MOVE_LIMIT the notice keeps the old id and signals its finished move", async () => {
  const f = await started({ config: { maxMoves: 1 } }); f.spawn.opened(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(500);
  reject(() => f.spawn.select(1, { id: "patio-de-hogwarts" }), "MOVE_LIMIT");
  f.spawn.notify(1, "limite", "MOVE_LIMIT");
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "done", notice: "limite" });
});
test("SEC-12: abandon cancels a choosing selection once with CLIENT_ABORTED, releases the hold and closes the page", async () => {
  const f = await started(); f.spawn.opened(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.spawn.abandon(1, { id: "ignored", x: 1 }), true);
  assert.deepEqual(f.events.map(e => [e.name, e.payload.reason]), [["ms:spawnCancelled", "CLIENT_ABORTED"]]);
  assert.equal(f.lastState(1).status, "closed"); assert.equal(f.native.holders.has("preview"), false);
  assert.equal(f.spawn.api.holds(1, "s1"), false);
  reject(() => f.spawn.abandon(1), "SESSION_EXPIRED"); // a second one finds no selection: ignored, nothing more emitted
  assert.equal(f.events.length, 1);
});
test("SEC-12: abandon is ignored while applying (ms-character owns the outcome) and without a selection", async () => {
  const f = await started(); f.spawn.opened(1);
  await ready(f, "hogsmeade"); f.spawn.confirm(1, { id: "hogsmeade" }); f.advance(500);
  assert.equal(f.spawn.abandon(1), false);
  assert.deepEqual(f.names(), ["ms:spawnSelected"]);
  reject(() => f.spawn.abandon(9), "SESSION_EXPIRED");
});
test("SEC-12: abandon works before the page acked and is bounded by the ingress bucket", async () => {
  const f = await started();
  assert.equal(f.spawn.abandon(1), true); assert.equal(f.events[0].payload.reason, "CLIENT_ABORTED");
  const g = await started();
  for (let i = 0; i < 10; i++) g.spawn.opened(1); // drain the bucket (10 events)
  reject(() => g.spawn.abandon(1), "INGRESS_DROPPED");
  assert.deepEqual(g.events, []); // dropped silently, the selection is untouched
});

// ---- CHG-03: preview snapToGround option and timing log -------------------------------------------------------------------
test("CHG-03: the preview teleport asks for snapToGround only when MS_SPAWN_PREVIEW_SNAP_TO_GROUND is on", async () => {
  const off = await started();
  off.spawn.select(1, { id: "hogsmeade" }); await off.settle();
  assert.deepEqual(off.native.options, [{ snapToGround: false }]);
  const on = await started({ config: { previewSnapToGround: true } });
  on.spawn.select(1, { id: "hogsmeade" }); await on.settle();
  assert.deepEqual(on.native.options, [{ snapToGround: true }]);
});
test("CHG-03: the hold is re-applied after a no-snap teleport and confirm stays gated as before", async () => {
  const f = await started();
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.native.log.at(-1), "hold:1100,2200");
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "done" });
});
test("CHG-03: one timing line per select result, without coordinates or account data", async () => {
  const f = await started({ config: { previewSnapToGround: true } });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.native.logs.length, 1);
  assert.match(f.native.logs[0], /^\[ms-spawn\] timing player=1 select=hogsmeade teleportMs=\d+ status=0 snap=true$/);
  assert.doesNotMatch(f.native.logs[0], /1000|2000|300|s1|userId/);
  f.advance(500); f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  assert.equal(f.native.logs.length, 2);
  assert.match(f.native.logs[1], /select=patio-de-hogwarts .* snap=true$/);
});
test("CHG-03: the timing line carries the failure status and the timeout; synthetic replaced results are not logged", async () => {
  const f = await started(undefined, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.native.teleports[0].resolve({ result: "failed", status: 3 }); await f.settle();
  assert.match(f.native.logs[0], /status=3 snap=false$/);
  f.advance(500); f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  f.native.teleports[1].resolve({ result: "timeout" }); await f.settle();
  assert.match(f.native.logs[1], /status=timeout snap=false$/);
  f.advance(500); f.spawn.select(1, { id: "patio-de-hogwarts" }); await f.settle();
  f.native.teleports[2].resolve({ result: "replaced" }); await f.settle();
  assert.equal(f.native.logs.length, 2);
});
test("CHG-03: MS_SPAWN_TIMING_LOG off writes no server line and the open payload carries timingLog false", async () => {
  const f = await started({ config: { timingLog: false } });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.deepEqual(f.native.logs, []);
  assert.equal(f.native.opens[0].timingLog, false);
  const on = await started();
  assert.equal(on.native.opens[0].timingLog, true);
});

// ---- CHG-05 (STORY-02.16): the preview goes to the camera position, the confirm to the spawn point -----------------------------
const SPAWN = { x: 1000, y: 2000, z: 300, yaw: 90 }, CAM = { x: 1100, y: 2200, z: 330 }; // the default test camera of withCamera()
test("02.16: select of a configured location teleports to the camera (with the spawn point's yaw) and holds there, not at the spawn point", async () => {
  const f = await started();
  f.spawn.select(1, { id: "hogsmeade", x: 5, camera: { x: 9, y: 9, z: 9 }, lookAt: { x: 8, y: 8, z: 8 } }); await f.settle();
  assert.deepEqual({ ...f.native.teleports[0].point }, { ...CAM, yaw: SPAWN.yaw });
  assert.deepEqual(f.native.options, [{ snapToGround: false }]);
  assert.equal(f.native.log.at(-1), "hold:" + CAM.x + "," + CAM.y);
  assert.equal(f.native.log.some(entry => entry === "teleport:" + SPAWN.x + "," + SPAWN.y || entry === "hold:" + SPAWN.x + "," + SPAWN.y), false);
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "done" });
});
test("02.16: select of last keeps the stored position as target", async () => {
  const f = fixture(); f.join(); f.req(1, LAST);
  f.spawn.select(1, { id: "last" }); await f.settle();
  assert.deepEqual({ ...f.native.teleports[0].point }, LAST);
  assert.equal(f.native.log.at(-1), "hold:11,22");
});
test("02.16: the confirm emits the spawn point, never the camera or the lookAt", async () => {
  const f = await started();
  await ready(f, "hogsmeade"); f.spawn.confirm(1, { id: "hogsmeade" });
  assert.deepEqual(f.events.at(-1).payload.destination, SPAWN);
  assert.equal(JSON.stringify(f.events).includes("1100"), false);
  const g = fixture(); g.join(); g.req(1, LAST);
  g.spawn.select(1, { id: "last" }); await g.settle(); g.advance(FLIGHT); g.spawn.arrived(1, { id: "last" }); g.advance(500); g.spawn.confirm(1, { id: "last" });
  assert.deepEqual(g.events.at(-1).payload.destination, LAST);
});
test("02.16: rapid selects end with the re-hold at the camera of the last one; status 1 of an older move is ignored", async () => {
  const f = await started({ locations: [...LOCATIONS, { name: "C", x: 7, y: 8, z: 9, yaw: 0 }] }, { auto: false });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(250);
  f.spawn.select(1, { id: "c" }); await f.settle();
  f.native.teleports[0].resolve({ result: "replaced", status: 1 }); await f.settle();
  assert.deepEqual(f.native.holders.has("preview"), false);
  f.native.teleports.at(-1).resolve(OK); await f.settle();
  assert.equal(f.native.log.at(-1), "hold:107,208");
  assert.equal(f.native.maxActive, 1);
});
test("02.16: the timing log and the failure notice carry no coordinates of the camera either", async () => {
  const f = await started({ config: { timingLog: true } });
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.ok(f.native.logs.length >= 1); assert.doesNotMatch(f.native.logs.join("\n"), /1100|2200|330|1000|2000/);
});
