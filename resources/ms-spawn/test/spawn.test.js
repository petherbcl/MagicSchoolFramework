"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpawn, cameraPose, departurePose } = require("../server/spawn");
const { loadConfig } = require("../server/config");

const LOCATIONS = [
  { name: "Hogsmeade", x: 1000, y: 2000, z: 300, yaw: 90 },
  { name: "Pátio de Hogwarts", x: -50.5, y: 60, z: 7, yaw: -16.3 },
];
function fixture(t, { locations = LOCATIONS, settings = {} } = {}) {
  let now = 1000000;
  const config = loadConfig({ MS_SPAWN_LOCATIONS: JSON.stringify(locations) }, { envFile: null });
  const sessions = new Map(), events = [], opened = [], states = [];
  const core = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.get(id)?.ready === true } };
  // Fake native player: ownership of holds is modelled so tests can prove the player is never unheld by a takeover.
  const native = { holders: new Set(["lobby"]), log: [], teleports: [], releases: 0, active: 0, maxActive: 0, auto: true, takeoverOk: true, holdOk: true, throwTeleport: false, nextRequest: 1 };
  const game = {
    open: (id, payload) => opened.push({ id, payload }), state: (id, payload) => states.push({ id, payload }),
    takeover() { native.log.push("takeover"); if (!native.takeoverOk) return false; native.holders.add("preview"); native.log.push("hold:preview"); native.holders.delete("lobby"); native.log.push("release:lobby"); return true; },
    hold(id, point) { native.log.push("hold:" + (point ? point.x + "," + point.y : "here")); if (!native.holdOk) return false; native.holders.add("preview"); return true; },
    release() { native.log.push("release:preview"); native.releases++; native.holders.delete("preview"); },
    teleport(id, point) {
      native.log.push("teleport:" + point.x + "," + point.y);
      if (native.throwTeleport) throw new Error("native");
      const entry = { point, done: false }; native.teleports.push(entry);
      if (native.active > 0) native.superseded = (native.superseded || 0) + 1; // the adapter contract: a newer call supersedes
      native.active = 1; native.maxActive = Math.max(native.maxActive, native.active);
      return new Promise(resolve => { entry.resolve = result => { if (!entry.done) { entry.done = true; native.active = 0; resolve(result); } }; if (native.auto) entry.resolve({ result: "ok", status: 0 }); });
    },
    cancelTeleport() { native.log.push("cancel"); const last = native.teleports.at(-1); if (last && !last.done) last.resolve({ result: "replaced", status: 1 }); },
  };
  const spawn = createSpawn({ config: { ...config, ...settings }, game, core, notices: { TELEPORT_FAILED: "falha" }, clock: () => now, emit: (name, payload) => events.push({ name, payload }), logger: { error() {} } });
  spawn.start();
  const join = (id = 1, sessionId = "s" + id) => sessions.set(id, { sessionId, userId: "1", ready: true });
  const req = (id = 1, last = null) => spawn.request({ playerId: id, sessionId: "s" + id, userId: "1", characterId: "7", last });
  const names = () => events.map(e => e.name);
  const lastState = id => states.filter(s => s.id === id).at(-1)?.payload;
  const advance = ms => { now += ms; };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { spawn, sessions, events, opened, states, join, req, names, lastState, advance, settle, config, native };
}
const LAST = { x: 11, y: 22, z: 33, yaw: 44 };
const reject = (fn, code, f) => { if (f) f.advance(500); assert.throws(fn, { name: "SpawnError", code }); };
// select + arrival + gap, ready to confirm
const FLIGHT = 1300; // above the server minimum flight time (camera duration 1500 ms minus 250 ms tolerance)
const ready = async (f, id, player = 1) => { f.spawn.select(player, { id }); await f.settle(); f.advance(FLIGHT); f.spawn.arrived(player, { id }); f.advance(500); };

test("a request opens the selection with the offered list and server-derived cameras", async t => {
  const f = fixture(t); f.join();
  assert.equal(f.req(1, LAST), true);
  const { locations, flight, areaTimeoutMs } = f.opened[0].payload;
  assert.deepEqual(locations.map(l => [l.id, l.kind]), [["last", "last"], ["hogsmeade", "config"], ["patio-de-hogwarts", "config"]]);
  assert.deepEqual(flight, { durationMs: 1500, easing: "easeInOut" }); assert.equal(areaTimeoutMs, 15000);
  assert.deepEqual(f.lastState(1), { status: "choosing" });
  for (const l of locations) { assert.deepEqual(Object.keys(l).sort(), ["camera", "id", "kind", "name"]); assert.deepEqual(Object.keys(l.camera).sort(), ["departure", "position", "rotation"]); }
});
test("(g) the last location is offered only when provided and well formed", async t => {
  const f = fixture(t); f.join(); f.join(2); f.join(3);
  f.req(1); f.req(2, { x: NaN, y: 1, z: 1, yaw: 1 });
  assert.deepEqual(f.opened[0].payload.locations.map(l => l.id), ["hogsmeade", "patio-de-hogwarts"]);
  assert.deepEqual(f.opened[1].payload.locations.map(l => l.id), ["hogsmeade", "patio-de-hogwarts"]);
  f.req(3, { x: 1, y: 2, z: 3 }); // a missing yaw defaults to 0
  assert.deepEqual(f.opened[2].payload.locations[0], { id: "last", name: "Última localização", kind: "last", camera: { ...cameraPose({ x: 1, y: 2, z: 3, yaw: 0 }, f.config.camera), departure: departurePose({ x: 1, y: 2, z: 3, yaw: 0 }, f.config.camera) } });
});
test("the payload carries cameras, not spawn points, and the pose derivation is deterministic", async t => {
  const f = fixture(t); f.join(); f.req(1, LAST);
  const poses = f.opened[0].payload.locations.map(l => JSON.stringify(l.camera.position));
  for (const point of [LAST, ...LOCATIONS]) assert.equal(poses.includes(JSON.stringify({ x: point.x, y: point.y, z: point.z })), false);
  const text = JSON.stringify(f.opened[0].payload);
  assert.equal(text.includes("destination"), false);
  const camera = { distance: 1200, height: 600 };
  const pose = cameraPose({ x: 1000, y: 2000, z: 300, yaw: 90 }, camera);
  assert.deepEqual(pose, cameraPose({ x: 1000, y: 2000, z: 300, yaw: 90 }, camera));
  assert.deepEqual(pose.position, { x: 1000, y: 800, z: 900 }); // 1200 behind a +Y facing point, 600 above
  assert.equal(pose.rotation.yaw, 90); assert.equal(pose.rotation.roll, 0);
  assert.equal(pose.rotation.pitch, Math.round(-Math.atan2(600, 1200) * 180 / Math.PI * 100) / 100);
  for (const value of [...Object.values(pose.position), ...Object.values(pose.rotation)]) assert.ok(Number.isFinite(value));
});
test("(a) select or confirm with an id that is not offered is rejected and never emits ms:spawnSelected", async t => {
  const f = fixture(t); f.join(); f.req(1);
  reject(() => f.spawn.select(1, { id: "last" }), "INVALID_LOCATION", f);
  reject(() => f.spawn.select(1, { id: "nowhere" }), "INVALID_LOCATION", f);
  reject(() => f.spawn.select(1, { id: 5 }), "INVALID_LOCATION", f);
  reject(() => f.spawn.select(1, null), "INVALID_LOCATION", f);
  f.advance(500); await ready(f, "hogsmeade");
  reject(() => f.spawn.confirm(1, { id: "nowhere" }), "INVALID_LOCATION");
  assert.equal(f.names().includes("ms:spawnSelected"), false);
  assert.equal(f.lastState(1).status, "choosing");
});
test("(b),(h) client coordinates are ignored and the destination equals the configuration exactly", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.spawn.select(1, { id: "patio-de-hogwarts", x: 9, y: 9, z: 9, yaw: 9, destination: { x: 1 } }); await f.settle();
  f.advance(FLIGHT); f.spawn.arrived(1, { id: "patio-de-hogwarts", x: 5 }); f.advance(500);
  f.spawn.confirm(1, { id: "patio-de-hogwarts", x: 1, y: 2, z: 3, yaw: 4 });
  assert.deepEqual(f.events.at(-1), { name: "ms:spawnSelected", payload: { playerId: 1, sessionId: "s1", destination: { x: -50.5, y: 60, z: 7, yaw: -16.3 } } });
  assert.equal(f.lastState(1).status, "applying");
});
test("confirming the last location emits the last coordinates unchanged", async t => {
  const f = fixture(t); f.join(); f.req(1, LAST);
  await ready(f, "last"); f.spawn.confirm(1, { id: "last" });
  assert.deepEqual(f.events.at(-1).payload.destination, LAST);
});
test("(c) confirm before the arrived gate is rejected unless the fallback timer elapsed", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(500);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED");
  f.advance(f.config.areaTimeoutMs);
  f.spawn.confirm(1, { id: "hogsmeade" });
  assert.equal(f.events.at(-1).name, "ms:spawnSelected");
});
test("an arrival for another location does not open the gate, and a new select resets it", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.spawn.select(1, { id: "hogsmeade" }); f.advance(500);
  assert.equal(f.spawn.arrived(1, { id: "patio-de-hogwarts" }), false);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED");
  f.advance(FLIGHT); assert.equal(f.spawn.arrived(1, { id: "hogsmeade" }), true);
  f.advance(500); f.spawn.select(1, { id: "patio-de-hogwarts" }); f.advance(500);
  reject(() => f.spawn.confirm(1, { id: "patio-de-hogwarts" }), "NOT_ARRIVED");
});
test("confirm of an id other than the selected one is rejected", async t => {
  const f = fixture(t); f.join(); f.req(1);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "LOCATION_REJECTED");
  f.advance(500); await ready(f, "hogsmeade");
  reject(() => f.spawn.confirm(1, { id: "patio-de-hogwarts" }), "LOCATION_REJECTED");
});
test("(f) after a rejection the selection stays and a second valid confirm succeeds", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle(); f.advance(500);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED");
  f.spawn.notify(1, "aviso");
  assert.deepEqual(f.lastState(1), { status: "choosing", selectedId: "hogsmeade", teleport: "done", notice: "aviso" });
  f.advance(FLIGHT); f.spawn.arrived(1, { id: "hogsmeade" }); f.advance(500);
  f.spawn.confirm(1, { id: "hogsmeade" });
  assert.equal(f.events.filter(e => e.name === "ms:spawnSelected").length, 1);
});
test("a second confirm after applying is an invalid state and emits nothing more", async t => {
  const f = fixture(t); f.join(); f.req(1);
  await ready(f, "hogsmeade"); f.spawn.confirm(1, { id: "hogsmeade" }); f.advance(500);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "INVALID_STATE");
  reject(() => f.spawn.select(1, { id: "patio-de-hogwarts" }), "INVALID_STATE");
  assert.equal(f.events.filter(e => e.name === "ms:spawnSelected").length, 1);
});
test("(d) a reused playerId with a different sessionId cannot confirm", async t => {
  const f = fixture(t); f.join(); f.req(1);
  await ready(f, "hogsmeade");
  f.join(1, "other-session"); // same native id, new session
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "SESSION_EXPIRED");
  assert.equal(f.names().includes("ms:spawnSelected"), false);
});
test("a stale request (session already replaced or not ready) opens nothing and emits nothing", async t => {
  const f = fixture(t); f.join(1, "new");
  assert.equal(f.spawn.request({ playerId: 1, sessionId: "old", userId: "1", characterId: "1", last: null }), false);
  f.sessions.set(2, { sessionId: "s2", ready: false });
  assert.equal(f.req(2), false);
  assert.deepEqual([f.opened.length, f.events.length], [0, 0]);
});
test("(e) session end and disconnect during choosing close the selection without emitting", async t => {
  const f = fixture(t); f.join(); f.join(2); f.req(1); f.req(2);
  f.spawn.sessionEnded("s1"); f.spawn.disconnect(2);
  assert.deepEqual(f.events, []);
  reject(() => f.spawn.select(1, { id: "hogsmeade" }), "SESSION_EXPIRED");
  reject(() => f.spawn.select(2, { id: "hogsmeade" }), "SESSION_EXPIRED");
  assert.equal(f.spawn.guard(1)(), false);
});
test("characterReady closes the page of an applying selection; other sessions are untouched", async t => {
  const f = fixture(t); f.join(); f.req(1);
  await ready(f, "hogsmeade"); f.spawn.confirm(1, { id: "hogsmeade" });
  f.spawn.characterReady({ playerId: 1, sessionId: "wrong" });
  assert.equal(f.lastState(1).status, "applying");
  f.spawn.characterReady({ playerId: 1, sessionId: "s1" });
  assert.deepEqual(f.lastState(1), { status: "closed" });
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "SESSION_EXPIRED");
});
test("NO_OPTIONS: nothing configured and no last cancels without opening", async t => {
  const f = fixture(t, { locations: [] }); f.join();
  assert.equal(f.req(1), false);
  assert.deepEqual(f.events, [{ name: "ms:spawnCancelled", payload: { playerId: 1, sessionId: "s1", reason: "NO_OPTIONS" } }]);
  assert.equal(f.opened.length, 0);
  f.req(1, LAST); // only the last location is available
  assert.deepEqual(f.opened[0].payload.locations.map(l => l.id), ["last"]);
});
test("NOT_READY: a request while ms-spawn is not ready is cancelled", async t => {
  const f = fixture(t); f.join(); f.spawn.stop();
  assert.equal(f.req(1), false);
  assert.deepEqual(f.events.map(e => e.payload.reason), ["NOT_READY"]);
  assert.equal(f.spawn.api.isReady(), false);
});
test("INTERNAL_ERROR: a failure while opening cancels for that player only, nothing is left pending", async t => {
  const f = fixture(t);
  const failing = createSpawn({ config: f.config, core: { Users: { get: () => ({ sessionId: "s1" }), isReady: () => true } },
    game: { open() { throw new Error("native"); }, state() {} }, emit: (n, p) => f.events.push({ name: n, payload: p }), logger: { error() {} } });
  failing.start();
  assert.equal(failing.request({ playerId: 1, sessionId: "s1", userId: "1", characterId: "1", last: null }), false);
  assert.deepEqual(f.events.map(e => e.payload.reason), ["INTERNAL_ERROR"]);
  assert.equal(failing.guard(1)(), false);
});
test("abort cancels a waiting selection with INTERNAL_ERROR, but not one that already answered", async t => {
  const f = fixture(t); f.join(); f.join(2); f.req(1); f.req(2);
  await ready(f, "hogsmeade", 2); f.spawn.confirm(2, { id: "hogsmeade" });
  f.events.length = 0;
  assert.equal(f.spawn.abort(1), true); assert.equal(f.spawn.abort(2), false);
  assert.deepEqual(f.events.map(e => e.payload.reason), ["INTERNAL_ERROR"]);
  assert.deepEqual(f.lastState(1), { status: "closed" });
});
test("STOPPED: stopping cancels waiting players and closes their pages", async t => {
  const f = fixture(t); f.join(); f.req(1); f.spawn.stop();
  assert.deepEqual(f.events, [{ name: "ms:spawnCancelled", payload: { playerId: 1, sessionId: "s1", reason: "STOPPED" } }]);
  assert.deepEqual(f.lastState(1), { status: "closed" });
});
test("every cancel reason is one of the closed set", async t => {
  const f = fixture(t, { locations: [] }); f.join(); f.req(1); f.spawn.stop(); f.req(1);
  for (const e of f.events) assert.ok(["NOT_READY", "NO_OPTIONS", "INTERNAL_ERROR", "STOPPED"].includes(e.payload.reason));
});
test("malformed requests are dropped without throwing or emitting", async t => {
  const f = fixture(t);
  for (const bad of [null, undefined, 5, {}, { playerId: "1", sessionId: "s" }, { playerId: 1, sessionId: "" }]) assert.equal(f.spawn.request(bad), false);
  assert.deepEqual(f.events, []);
});
test("rate limiting: select closer than the gap is refused without changing state", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.spawn.select(1, { id: "hogsmeade" });
  reject(() => f.spawn.select(1, { id: "patio-de-hogwarts" }), "RATE_LIMITED");
  assert.equal(f.lastState(1).selectedId, "hogsmeade");
  f.advance(250); f.spawn.select(1, { id: "patio-de-hogwarts" });
  assert.equal(f.lastState(1).selectedId, "patio-de-hogwarts");
});
test("a new request replaces the previous selection of the same player silently", async t => {
  const f = fixture(t); f.join(); f.req(1); f.req(1);
  assert.equal(f.opened.length, 2); assert.deepEqual(f.events, []);
});
test("the Spawn export is frozen, ready after start, and lists id/name only", async t => {
  const f = fixture(t);
  assert.equal(Object.isFrozen(f.spawn.api), true);
  assert.equal(f.spawn.api.isReady(), true); assert.equal(f.spawn.api.version, "0.3.2");
  const list = f.spawn.api.locations();
  assert.deepEqual(list, [{ id: "hogsmeade", name: "Hogsmeade" }, { id: "patio-de-hogwarts", name: "Pátio de Hogwarts" }]);
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list[0]));
  f.spawn.stop(); assert.equal(f.spawn.api.isReady(), false);
});

// ---- Security remediation (docs/security-audit-ms-spawn.md) -----------------------------------------------------------
test("SEC-01: 1000 confirms while applying produce at most one notice per 2 s", async t => {
  const f = fixture(t); f.join(); f.req(1);
  await ready(f, "hogsmeade"); f.spawn.confirm(1, { id: "hogsmeade" });
  const before = f.states.length;
  let delivered = 0, dropped = 0;
  for (let i = 0; i < 1000; i++) {
    try { f.spawn.confirm(1, { id: "hogsmeade" }); } catch (error) {
      if (error.code === "INGRESS_DROPPED") dropped++;
      else if (f.spawn.notify(1, "Aguarda a etapa atual.", error.code)) delivered++;
    }
  }
  assert.ok(delivered <= 1, "delivered " + delivered); assert.ok(dropped >= 980);
  assert.ok(f.states.length - before <= 1);
  f.advance(2000);
  assert.equal(f.spawn.notify(1, "Aguarda a etapa atual.", "INVALID_STATE"), true); // the cap is per window, not permanent
});
test("SEC-01: the notice cap applies to every code, independently per code", async t => {
  const f = fixture(t); f.join(); f.req(1);
  assert.equal(f.spawn.notify(1, "a", "NOT_ARRIVED"), true);
  assert.equal(f.spawn.notify(1, "a", "NOT_ARRIVED"), false);
  assert.equal(f.spawn.notify(1, "b", "INVALID_LOCATION"), true);
  f.advance(2000); assert.equal(f.spawn.notify(1, "a", "NOT_ARRIVED"), true);
});
test("SEC-01: 1000 arrived events are dropped after the bucket empties, and the bucket refills over time", async t => {
  const f = fixture(t); f.join(); f.req(1); f.spawn.select(1, { id: "hogsmeade" });
  let accepted = 0, dropped = 0;
  for (let i = 0; i < 1000; i++) { try { f.spawn.arrived(1, { id: "hogsmeade" }); accepted++; } catch (error) { assert.equal(error.code, "INGRESS_DROPPED"); dropped++; } }
  assert.ok(accepted <= 10 && dropped >= 990, `accepted ${accepted}`);
  f.advance(1000); assert.doesNotThrow(() => f.spawn.arrived(1, { id: "hogsmeade" }));
});
test("SEC-01: select and confirm are gated before any state check, and a dropped event changes nothing", async t => {
  const f = fixture(t); f.join(); f.req(1);
  for (let i = 0; i < 10; i++) try { f.spawn.arrived(1, { id: "x" }); } catch { /* drained */ }
  const before = f.states.length;
  assert.throws(() => f.spawn.select(1, { id: "hogsmeade" }), { code: "INGRESS_DROPPED" });
  assert.throws(() => f.spawn.confirm(1, { id: "hogsmeade" }), { code: "INGRESS_DROPPED" });
  assert.equal(f.states.length, before);
});
test("SEC-04: an early arrival report is ignored until the minimum flight time; the fallback timer still governs", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.spawn.select(1, { id: "hogsmeade" }); await f.settle();
  assert.equal(f.spawn.arrived(1, { id: "hogsmeade" }), false);
  f.advance(500);
  reject(() => f.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED");
  f.advance(700); assert.equal(f.spawn.arrived(1, { id: "hogsmeade" }), false); // 1200 ms < 1250 ms
  f.advance(100); assert.equal(f.spawn.arrived(1, { id: "hogsmeade" }), true);
  f.advance(500); f.spawn.confirm(1, { id: "hogsmeade" });
  assert.equal(f.names().includes("ms:spawnSelected"), true);
  // with no accepted report at all, the area timeout opens the gate
  const g = fixture(t); g.join(); g.req(1); g.spawn.select(1, { id: "hogsmeade" }); await g.settle();
  g.spawn.arrived(1, { id: "hogsmeade" }); g.advance(500);
  reject(() => g.spawn.confirm(1, { id: "hogsmeade" }), "NOT_ARRIVED");
  g.advance(g.config.areaTimeoutMs); g.spawn.confirm(1, { id: "hogsmeade" });
  assert.equal(g.names().includes("ms:spawnSelected"), true);
});
test("SEC-03: a client that never reports its page opened is cancelled with CLIENT_TIMEOUT", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.advance(29000); f.spawn.tick();
  assert.deepEqual(f.names(), []);
  f.advance(1000); f.spawn.tick();
  assert.deepEqual(f.events.map(e => [e.name, e.payload.reason]), [["ms:spawnCancelled", "CLIENT_TIMEOUT"]]);
  assert.equal(f.lastState(1).status, "closed");
  assert.equal(f.spawn.api.holds(1, "s1"), false);
  f.spawn.tick(); assert.equal(f.events.length, 1); // idempotent
});
test("SEC-03: an idle player is never timed out once the page is open", async t => {
  const f = fixture(t); f.join(); f.req(1);
  f.advance(5000); assert.equal(f.spawn.opened(1), true);
  f.advance(24 * 3600 * 1000); f.spawn.tick();
  assert.deepEqual(f.events, []); assert.equal(f.spawn.api.holds(1, "s1"), true);
  assert.equal(f.lastState(1).status, "choosing");
});
test("SEC-03: a stale or unknown opened ack is ignored; holds is false for another session", async t => {
  const f = fixture(t); f.join(); f.req(1);
  assert.throws(() => f.spawn.opened(9), { code: "SESSION_EXPIRED" });
  assert.equal(f.spawn.api.holds(1, "other"), false); assert.equal(f.spawn.api.holds(1, "s1"), true);
});
test("SEC-03: the acknowledgement timeout is configurable", async t => {
  const f = fixture(t, { settings: { openAckTimeoutMs: 6000 } }); f.join(); f.req(1);
  f.advance(6000); f.spawn.tick();
  assert.equal(f.events[0].payload.reason, "CLIENT_TIMEOUT");
});

// ---- CHG-02 (stories 02.11 / 01.05): departure pose, area ceiling default --------------------------------------------------
test("01.05: the default area ceiling is 15000 ms and is what the open payload carries", async t => {
  const f = fixture(t);
  assert.equal(f.config.areaTimeoutMs, 15000);
  f.join(); f.req(1);
  assert.equal(f.opened[0].payload.areaTimeoutMs, 15000);
});
test("02.11: every offered camera carries a departure pose, higher and farther than the target, derived on the server", async t => {
  const f = fixture(t); f.join(); f.req(1, LAST);
  for (const l of f.opened[0].payload.locations) {
    const { position, rotation, departure } = l.camera;
    assert.deepEqual(Object.keys(departure).sort(), ["position", "rotation"]);
    assert.ok(departure.position.z > position.z);
    const point = { last: LAST, hogsmeade: LOCATIONS[0], "patio-de-hogwarts": LOCATIONS[1] }[l.id];
    const far = Math.hypot(departure.position.x - point.x, departure.position.y - point.y), near = Math.hypot(position.x - point.x, position.y - point.y);
    assert.ok(far > near);
    assert.equal(departure.rotation.yaw, rotation.yaw); assert.equal(departure.rotation.roll, 0);
    for (const value of [...Object.values(departure.position), ...Object.values(departure.rotation)]) assert.ok(Number.isFinite(value));
  }
});
test("02.11: departurePose is cameraPose with the extra height and distance, deterministic; last derives the same way", async t => {
  const camera = { distance: 1200, height: 600, departureDistance: 3000, departureHeight: 1500 };
  const point = { x: 1000, y: 2000, z: 300, yaw: 90 };
  assert.deepEqual(departurePose(point, camera), cameraPose(point, { distance: 4200, height: 2100 }));
  assert.deepEqual(departurePose(point, camera), departurePose(point, camera));
  assert.deepEqual(departurePose(point, camera).position, { x: 1000, y: -2200, z: 2400 });
  const f = fixture(t); f.join(); f.req(1, LAST);
  assert.deepEqual(f.opened[0].payload.locations[0].camera.departure, departurePose({ ...LAST }, f.config.camera));
});
test("02.11: no spawn point and no extra field leak through the open payload; only offered locations carry poses", async t => {
  const f = fixture(t); f.join(); f.req(1, LAST);
  const payload = f.opened[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["areaTimeoutMs", "flight", "locations", "timingLog"]);
  const text = JSON.stringify(payload);
  for (const point of [LAST, ...LOCATIONS]) {
    for (const l of payload.locations) for (const pose of [l.camera.position, l.camera.departure.position]) assert.notDeepEqual(pose, { x: point.x, y: point.y, z: point.z });
  }
  // The only keys anywhere below `camera` are the pose shape: no spawn point field exists.
  const keys = new Set(); (function walk(v) { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) keys.add(k); walk(x); } })(payload.locations.map(l => l.camera));
  assert.deepEqual([...keys].sort(), ["departure", "pitch", "position", "roll", "rotation", "x", "y", "yaw", "z"]);
  assert.equal(text.includes("destination"), false);
  assert.equal(payload.locations.length, 3);
  const f2 = fixture(t, { locations: [] }); f2.join(); f2.req(1, LAST);
  assert.deepEqual(f2.opened[0].payload.locations.map(l => l.id), ["last"]);
});
