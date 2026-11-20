"use strict";

// Loads server/main.js in a vm sandbox with fake ArcaneMP server globals. server/main.js requires its sibling modules
// through a custom require, so the real config/spawn/game code runs. No game.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = value => JSON.parse(JSON.stringify(value));
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "server", "main.js"), "utf8");
const LOCATIONS = JSON.stringify([{ name: "Hogsmeade", x: 1, y: 2, z: 3, yaw: 4 }, { name: "Pátio", x: 5, y: 6, z: 7, yaw: 8 }]);

function harness({ locations = LOCATIONS, core = true } = {}) {
  const handlers = {}, clientHandlers = {}, exportsRegistered = {}, serverEvents = [], logs = [], errors = [];
  const sessions = new Map();
  const players = new Map();
  const makePlayer = id => {
    const emitted = [], natives = [];
    const p = { id, connected: true, emitted, natives, requestId: 0, emit: (name, payload) => emitted.push([name, JSON.parse(payload)]),
      location: () => ({ areaId: "Overland", x: 1, y: 1, z: 1, yaw: 0 }),
      hold: options => { natives.push(["hold", options]); return true; }, release: owner => { natives.push(["release", owner]); return true; },
      teleport: (x, y, z, options) => { natives.push(["teleport", x, y, z, options]); return ++p.requestId; } };
    players.set(id, p); return p;
  };
  const coreExport = { Users: { get: id => sessions.get(id) || null, isReady: id => sessions.get(id)?.ready === true } };
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(" ")), error: (...a) => errors.push(a.join(" ")) },
    Date, Promise, setTimeout, Error, setInterval, clearInterval,
    Events: {
      on: (name, fn) => { handlers[name] = fn; },
      onClient: (name, fn) => { clientHandlers[name] = fn; },
      emit: (name, payload) => serverEvents.push({ name, payload }),
    },
    Exports: { get: (resource, name) => { if (resource === "ms-core") { if (core) return coreExport; throw new Error("no resource"); } return exportsRegistered[resource + ":" + name] || null; },
      register: (name, value) => { exportsRegistered["ms-spawn:" + name] = value; return true; } },
    PlayerManager: { getById: id => players.get(id) || null },
    // The config must never read the real resources/ms-spawn/.env (edited by the user, made earlier runs flaky): same
    // loadConfig, but with the .env file switched off so only process.env (set above) counts.
    require: request => {
      if (request === "./config") { const real = require("../server/config"); return { ...real, loadConfig: (env = process.env) => real.loadConfig(env, { envFile: null }) }; }
      return request.startsWith(".") ? require(path.join(__dirname, "..", "server", request)) : require(request);
    },
  };
  // The config reads process.env: point it at the fake list for this run.
  const previous = process.env.MS_SPAWN_LOCATIONS, previousDuration = process.env.MS_SPAWN_CAMERA_DURATION_MS;
  process.env.MS_SPAWN_CAMERA_DURATION_MS = "300"; // minimum flight time 50 ms: real-time tests stay fast
  if (locations === undefined) delete process.env.MS_SPAWN_LOCATIONS; else process.env.MS_SPAWN_LOCATIONS = locations;
  vm.runInNewContext(SOURCE, sandbox, { filename: "server/main.js" });
  const restore = () => { if (previousDuration === undefined) delete process.env.MS_SPAWN_CAMERA_DURATION_MS; else process.env.MS_SPAWN_CAMERA_DURATION_MS = previousDuration; if (previous === undefined) delete process.env.MS_SPAWN_LOCATIONS; else process.env.MS_SPAWN_LOCATIONS = previous; };
  const join = id => { sessions.set(id, { sessionId: "s" + id, ready: true }); return makePlayer(id); };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { handlers, clientHandlers, exportsRegistered, serverEvents, logs, errors, join, flush, restore, sessions,
    start: () => handlers.resourceStart("ms-spawn"), stop: () => handlers.resourceStop("ms-spawn"),
    request: id => handlers["ms:spawnSelectionRequested"]({ playerId: id, sessionId: "s" + id, userId: "1", characterId: "1", last: null }) };
}
const states = player => player.emitted.filter(([name]) => name === "ms-spawn:state").map(([, payload]) => payload);

test("resourceStart registers the Spawn export and isReady turns true; resourceStop turns it false", t => {
  const h = harness(); t.after(h.restore);
  h.start();
  const api = h.exportsRegistered["ms-spawn:Spawn"];
  assert.equal(api.isReady(), true); assert.equal(api.version, "0.3.2");
  assert.deepEqual(plain(api.locations()), [{ id: "hogsmeade", name: "Hogsmeade" }, { id: "patio", name: "Pátio" }]);
  assert.ok(h.logs.some(line => line.includes("ms-spawn ready")));
  h.stop(); assert.equal(api.isReady(), false);
});
test("an invalid configuration refuses to start: no export, error logged without values", t => {
  const h = harness({ locations: "[{broken" }); t.after(h.restore);
  assert.throws(() => h.start(), /MS_SPAWN_STARTUP_FAILED/);
  assert.equal(h.exportsRegistered["ms-spawn:Spawn"], undefined);
  assert.ok(h.errors.some(line => line.includes("LOCATIONS_INVALID_JSON")));
});
test("start fails closed when the ms-core export is unavailable", t => {
  const h = harness({ core: false }); t.after(h.restore);
  assert.throws(() => h.start(), /MS_SPAWN_STARTUP_FAILED/);
});
test("the open payload reaches the player as a JSON string with cameras only", t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  const open = player.emitted.find(([name]) => name === "ms-spawn:open")[1];
  assert.deepEqual(open.locations.map(l => l.id), ["hogsmeade", "patio"]);
  assert.equal(JSON.stringify(open).includes("destination"), false);
  assert.notDeepEqual(plain(open.locations[0].camera.position), { x: 1, y: 2, z: 3 });
  assert.deepEqual(states(player).at(-1), { status: "choosing" });
});
test("a full flow: select, arrived, confirm emits ms:spawnSelected; characterReady closes the page", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.clientHandlers["ms-spawn:select"](player, { id: "hogsmeade", x: 99 }); await h.flush();
  h.handlers.playerTeleportComplete(player, player.requestId, 0); await h.flush();
  await new Promise(resolve => setTimeout(resolve, 80)); // above the minimum flight time (300 ms camera - 250 ms)
  h.clientHandlers["ms-spawn:arrived"](player, { id: "hogsmeade" }); await h.flush();
  await new Promise(resolve => setTimeout(resolve, 260));
  h.clientHandlers["ms-spawn:confirm"](player, { id: "hogsmeade" }); await h.flush();
  assert.deepEqual(plain(h.serverEvents.at(-1)), { name: "ms:spawnSelected", payload: { playerId: 1, sessionId: "s1", destination: { x: 1, y: 2, z: 3, yaw: 4 } } });
  h.handlers["ms:characterReady"]({ playerId: 1, sessionId: "s1" });
  assert.deepEqual(states(player).at(-1), { status: "closed" });
});
test("malformed client payloads never throw and never change state", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1); const before = player.emitted.length;
  for (const bad of [undefined, null, 5, "x", {}, { id: 5 }, { id: "x".repeat(65) }, { id: ["a"] }, []]) {
    for (const name of ["ms-spawn:select", "ms-spawn:arrived", "ms-spawn:confirm"]) h.clientHandlers[name](player, bad);
  }
  await h.flush();
  assert.equal(player.emitted.length, before);
  assert.deepEqual(h.serverEvents, []);
});
test("known SpawnError codes become pt-PT notices that keep the selection, never a kick", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.clientHandlers["ms-spawn:select"](player, { id: "nowhere" }); await h.flush();
  assert.deepEqual(states(player).at(-1), { status: "choosing", notice: "O servidor rejeitou este local. Escolhe outro local e tenta de novo." });
  await new Promise(resolve => setTimeout(resolve, 260));
  h.clientHandlers["ms-spawn:select"](player, { id: "hogsmeade" }); await h.flush();
  await new Promise(resolve => setTimeout(resolve, 260));
  h.clientHandlers["ms-spawn:confirm"](player, { id: "hogsmeade" }); await h.flush();
  assert.deepEqual(states(player).at(-1), { status: "choosing", selectedId: "hogsmeade", notice: "Aguarda a chegada ao local antes de confirmares." });
  assert.equal(player.kicked, undefined);
});
test("rate limited notices are sent at most once per 2 seconds", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.clientHandlers["ms-spawn:select"](player, { id: "hogsmeade" }); await h.flush();
  for (let i = 0; i < 20; i++) h.clientHandlers["ms-spawn:select"](player, { id: "patio" });
  await h.flush();
  assert.equal(states(player).filter(s => s.notice === "Aguarda antes de repetir.").length, 1);
});
test("an unexpected error cancels the selection with INTERNAL_ERROR instead of kicking", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  player.emit = (name, payload) => { if (name === "ms-spawn:state" && JSON.parse(payload).selectedId) throw new TypeError("boom"); player.emitted.push([name, JSON.parse(payload)]); };
  h.clientHandlers["ms-spawn:select"](player, { id: "hogsmeade" }); await h.flush();
  assert.deepEqual(plain(h.serverEvents.at(-1)), { name: "ms:spawnCancelled", payload: { playerId: 1, sessionId: "s1", reason: "INTERNAL_ERROR" } });
  assert.ok(h.errors.some(line => line.includes("operation failed")));
});
test("client events before the resource is ready or after it stops are ignored", async t => {
  const h = harness(); t.after(h.restore);
  const player = h.join(1);
  h.clientHandlers["ms-spawn:select"](player, { id: "hogsmeade" }); h.request(1); await h.flush();
  assert.deepEqual([player.emitted.length, h.serverEvents.length], [0, 0]);
});
test("resourceStop mid selection emits ms:spawnCancelled STOPPED and closes the page", t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.stop();
  assert.deepEqual(plain(h.serverEvents.at(-1)), { name: "ms:spawnCancelled", payload: { playerId: 1, sessionId: "s1", reason: "STOPPED" } });
  assert.deepEqual(states(player).at(-1), { status: "closed" });
});
test("session end and disconnect close the selection silently", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const one = h.join(1), two = h.join(2); h.request(1); h.request(2);
  h.handlers["ms:sessionEnded"]({ sessionId: "s1" }); h.handlers.playerDisconnect(two);
  h.clientHandlers["ms-spawn:select"](one, { id: "hogsmeade" }); await h.flush();
  assert.deepEqual(h.serverEvents, []);
});
test("a selection request before the resource started is ignored", t => {
  const h = harness(); t.after(h.restore);
  h.join(1); h.request(1);
  assert.deepEqual(h.serverEvents, []);
});
test("SEC-01/SEC-03: ms-spawn:opened is routed, a flood of confirms in applying yields at most one notice, and the watchdog stops with the resource", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.clientHandlers["ms-spawn:opened"](player, {}); await h.flush();
  h.clientHandlers["ms-spawn:select"](player, { id: "hogsmeade" }); await h.flush();
  await new Promise(resolve => setTimeout(resolve, 380));
  h.clientHandlers["ms-spawn:arrived"](player, { id: "hogsmeade" }); await h.flush();
  await new Promise(resolve => setTimeout(resolve, 260));
  h.clientHandlers["ms-spawn:confirm"](player, { id: "hogsmeade" }); await h.flush();
  const before = player.emitted.length;
  for (let i = 0; i < 1000; i++) h.clientHandlers["ms-spawn:confirm"](player, { id: "hogsmeade" });
  await h.flush();
  assert.ok(player.emitted.length - before <= 1, "notices: " + (player.emitted.length - before));
  h.stop(); // clears the interval; must not throw
});

const settleTeleport = (h, player, status) => h.handlers.playerTeleportComplete(player, player.requestId, status);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test("CHG-01: select takes the hold over, teleports without snapToGround (CHG-03 default) and re-holds after playerTeleportComplete status 0", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.clientHandlers["ms-spawn:select"](player, { id: "patio", x: 99 }); await h.flush();
  assert.deepEqual(player.natives.map(entry => entry[0] + (entry[1]?.owner ? ":" + entry[1].owner : typeof entry[1] === "string" ? ":" + entry[1] : "")),
    ["hold:ms-spawn:preview", "release:ms-character:lobby", "release:ms-spawn:preview", "teleport"]);
  assert.deepEqual(plain(player.natives.at(-1)), ["teleport", 5, 6, 7, { yaw: 8 }]);
  settleTeleport(h, player, 0); await h.flush();
  const hold = player.natives.at(-1)[1];
  assert.deepEqual(plain(hold), { owner: "ms-spawn:preview", x: 5, y: 6, z: 7, mode: "clamp", radius: 0, radiusZ: 0, ttlMs: 1800000 });
});
test("CHG-03: the real wiring sends timingLog (default on) in ms-spawn:open and teleports without snap", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  assert.equal(plain(player.emitted.find(([name]) => name === "ms-spawn:open")[1]).timingLog, true);
  h.clientHandlers["ms-spawn:select"](player, { id: "patio" }); await h.flush();
  assert.equal("snapToGround" in plain(player.natives.at(-1))[4], false);
});
test("CHG-01: playerTeleportComplete for unknown request ids or players is ignored; status 1 and 4 handled by status", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.handlers.playerTeleportComplete(player, 12345, 0); h.handlers.playerTeleportComplete(null, 1, 0);
  h.clientHandlers["ms-spawn:select"](player, { id: "patio" }); await h.flush();
  h.handlers.playerTeleportComplete(player, player.requestId + 50, 4); await h.flush();
  assert.equal(states(player).some(s => s.notice), false); // still pending: a foreign id changed nothing
  settleTeleport(h, player, 4); await h.flush();
  assert.deepEqual(states(player).at(-1), { status: "choosing", selectedId: "patio", teleport: "failed", notice: "Não foi possível preparar este local. Tenta de novo ou escolhe outro local." });
  assert.deepEqual(h.serverEvents, []);
});
test("CHG-01: confirm during a pending teleport gets the NOT_ARRIVED notice; confirm releases the preview hold", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.clientHandlers["ms-spawn:select"](player, { id: "hogsmeade" }); await h.flush();
  await wait(380); h.clientHandlers["ms-spawn:arrived"](player, { id: "hogsmeade" }); await h.flush(); await wait(260);
  h.clientHandlers["ms-spawn:confirm"](player, { id: "hogsmeade" }); await h.flush();
  assert.equal(states(player).at(-1).notice, "Aguarda a chegada ao local antes de confirmares.");
  settleTeleport(h, player, 0); await h.flush(); await wait(260);
  const releasesBefore = player.natives.filter(entry => entry[0] === "release").length;
  h.clientHandlers["ms-spawn:confirm"](player, { id: "hogsmeade" }); await h.flush();
  assert.equal(h.serverEvents.at(-1).name, "ms:spawnSelected");
  assert.equal(player.natives.filter(entry => entry[0] === "release").length, releasesBefore + 1);
  assert.deepEqual(player.natives.at(-1), ["release", "ms-spawn:preview"]);
});
test("CHG-01: resourceStop and session end release the preview hold", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const one = h.join(1), two = h.join(2); h.request(1); h.request(2);
  h.clientHandlers["ms-spawn:select"](one, { id: "hogsmeade" }); h.clientHandlers["ms-spawn:select"](two, { id: "hogsmeade" }); await h.flush();
  settleTeleport(h, one, 0); settleTeleport(h, two, 0); await h.flush();
  h.handlers["ms:sessionEnded"]({ sessionId: "s1" });
  assert.deepEqual(one.natives.at(-1), ["release", "ms-spawn:preview"]);
  h.stop();
  assert.deepEqual(two.natives.at(-1), ["release", "ms-spawn:preview"]);
});

test("SEC-12: ms-spawn:abandon is routed behind the ingress gate, reads no payload and cancels with CLIENT_ABORTED once", async t => {
  const h = harness(); t.after(h.restore); h.start();
  const player = h.join(1); h.request(1);
  h.clientHandlers["ms-spawn:opened"](player, {}); await h.flush();
  h.clientHandlers["ms-spawn:abandon"](player, { id: "x", reason: "y" }); await h.flush();
  h.clientHandlers["ms-spawn:abandon"](player, {}); await h.flush(); // no selection any more: ignored, no kick, no notice
  const cancelled = h.serverEvents.filter(e => e.name === "ms:spawnCancelled");
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0].payload.reason, "CLIENT_ABORTED");
  assert.equal(states(player).at(-1).status, "closed"); assert.deepEqual(h.errors, []);
  h.stop();
});
