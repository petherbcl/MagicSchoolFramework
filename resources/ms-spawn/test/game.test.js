"use strict";
// Story 02.06: native adapter with a fake player and injected timers (no global setTimeout).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGameAdapter, PREVIEW_OWNER, LOBBY_OWNER } = require("../server/game");

function harness({ location = { areaId: "Overland", x: 5, y: 6, z: 7 }, holdOk = true, teleportResult } = {}) {
  const calls = [], timers = new Map(); let nextTimer = 1, nextRequest = 100;
  const player = { id: 1, connected: true, emit: (name, payload) => calls.push(["emit", name, JSON.parse(payload)]),
    location: () => location,
    hold: options => { calls.push(["hold", options]); return holdOk; },
    release: owner => { calls.push(["release", owner]); return true; },
    teleport: (x, y, z, options) => { calls.push(["teleport", x, y, z, options]); return teleportResult === undefined ? nextRequest++ : teleportResult; } };
  const players = new Map([[1, player]]);
  const game = createGameAdapter({ getPlayer: id => players.get(id) || null,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id), teleportTimeoutMs: 5000 });
  const fire = () => { const [id, timer] = [...timers.entries()][0]; timers.delete(id); timer.fn(); };
  return { game, player, calls, timers, fire, named: name => calls.filter(call => call[0] === name) };
}
const POINT = { x: 10, y: 20, z: 30, yaw: 45 };

test("teleport resolves ok on status 0 with the right requestId and uses snapToGround and the point yaw", async () => {
  const h = harness();
  const pending = h.game.teleport(1, POINT);
  assert.deepEqual(h.calls[0], ["teleport", 10, 20, 30, { yaw: 45, snapToGround: true }]);
  assert.equal(h.game.complete(1, 100, 0), true);
  assert.deepEqual(await pending, { result: "ok", status: 0 });
  assert.equal(h.timers.size, 0, "the timeout timer is cleared");
});
test("status 1 resolves replaced; statuses 2 to 5 resolve failed with the status", async () => {
  const h = harness();
  let pending = h.game.teleport(1, POINT); h.game.complete(1, 100, 1);
  assert.deepEqual(await pending, { result: "replaced", status: 1 });
  for (const status of [2, 3, 4, 5]) {
    pending = h.game.teleport(1, POINT); h.game.complete(1, 100 + status - 1, status);
    assert.deepEqual(await pending, { result: "failed", status });
  }
});
test("a timeout resolves timeout and discards the request id", async () => {
  const h = harness();
  const pending = h.game.teleport(1, POINT);
  assert.equal(h.timers.get(1).ms, 5000);
  h.fire();
  assert.deepEqual(await pending, { result: "timeout" });
  assert.equal(h.game.complete(1, 100, 0), false);
});
test("unknown request ids, unknown players and repeated completions are ignored without throwing", async () => {
  const h = harness();
  assert.equal(h.game.complete(1, 100, 0), false); assert.equal(h.game.complete(9, 1, 0), false);
  const pending = h.game.teleport(1, POINT);
  assert.equal(h.game.complete(1, 999, 0), false); assert.equal(h.game.complete(2, 100, 0), false);
  assert.equal(h.game.complete(1, 100, 0), true); assert.equal(h.game.complete(1, 100, 0), false);
  assert.equal((await pending).result, "ok");
});
test("a newer teleport of the same player supersedes the pending one; cancelTeleport resolves it replaced", async () => {
  const h = harness();
  const first = h.game.teleport(1, POINT), second = h.game.teleport(1, POINT);
  assert.deepEqual(await first, { result: "replaced" });
  assert.equal(h.game.complete(1, 100, 0), false, "the superseded request id no longer counts");
  h.game.complete(1, 101, 0); assert.equal((await second).result, "ok");
  const third = h.game.teleport(1, POINT); h.game.cancelTeleport(1);
  assert.deepEqual(await third, { result: "replaced" });
  assert.equal(h.game.cancelTeleport(1), false);
});
test("a refused or throwing native teleport resolves failed; a missing player rejects", async () => {
  assert.deepEqual(await harness({ teleportResult: 0 }).game.teleport(1, POINT), { result: "failed", status: null });
  assert.deepEqual(await harness({ teleportResult: false }).game.teleport(1, POINT), { result: "failed", status: null });
  const h = harness(); h.player.teleport = () => { throw new Error("native"); };
  assert.deepEqual(await h.game.teleport(1, POINT), { result: "failed", status: null });
  await assert.rejects(h.game.teleport(9, POINT));
  h.player.connected = false; await assert.rejects(h.game.teleport(1, POINT));
});
test("hold uses the ms-spawn owner and the radius 0 clamp of ms-character; release only releases that owner", () => {
  const h = harness();
  assert.equal(h.game.hold(1, POINT), true);
  assert.deepEqual(h.calls[0], ["hold", { owner: PREVIEW_OWNER, x: 10, y: 20, z: 30, mode: "clamp", radius: 0, radiusZ: 0, ttlMs: 1800000 }]);
  h.game.release(1);
  assert.deepEqual(h.calls[1], ["release", PREVIEW_OWNER]);
  assert.equal(PREVIEW_OWNER, "ms-spawn:preview");
  assert.equal(h.calls.some(call => call[0] === "release" && call[1] === LOBBY_OWNER), false);
});
test("hold(null) holds at the player's current position; an unreadable position or refused hold returns false", () => {
  const h = harness();
  assert.equal(h.game.hold(1, null), true);
  assert.deepEqual([h.calls[0][1].x, h.calls[0][1].y, h.calls[0][1].z], [5, 6, 7]);
  assert.equal(harness({ location: null }).game.hold(1, null), false);
  assert.equal(harness({ holdOk: false }).game.hold(1, POINT), false);
  assert.equal(h.game.hold(9, POINT), false);
});
test("takeover holds with the new owner first, then releases the lobby owner; a refusal changes nothing", () => {
  const h = harness();
  assert.equal(h.game.takeover(1), true);
  assert.deepEqual(h.calls.map(call => call[0] + ":" + (call[1].owner || call[1])), ["hold:" + PREVIEW_OWNER, "release:" + LOBBY_OWNER]);
  const refused = harness({ holdOk: false });
  assert.equal(refused.game.takeover(1), false); assert.deepEqual(refused.named("release"), []);
  const blind = harness({ location: { areaId: "Overland", x: NaN, y: 0, z: 0 } });
  assert.equal(blind.game.takeover(1), false); assert.deepEqual(blind.named("hold"), []);
});
test("open and state still emit JSON strings, and skip a disconnected player", () => {
  const h = harness();
  h.game.open(1, { a: 1 }); h.game.state(1, { status: "choosing" });
  assert.deepEqual(h.named("emit").map(call => call.slice(1)), [["ms-spawn:open", { a: 1 }], ["ms-spawn:state", { status: "choosing" }]]);
  h.player.connected = false; h.game.state(1, {});
  assert.equal(h.named("emit").length, 2);
});

test("SEC-10: a teleport that lands after it was cancelled, superseded or timed out is recognised, ignored and logged once", async () => {
  const errors = [];
  const h = harness();
  const game = createGameAdapter({ getPlayer: () => h.player, setTimeout: (fn, ms) => 1, clearTimeout() {}, logger: { error: message => errors.push(message) } });
  const first = game.teleport(1, POINT); game.cancelTeleport(1); assert.deepEqual(await first, { result: "replaced" });
  assert.equal(game.complete(1, 100, 0), false); assert.equal(errors.length, 1);
  assert.equal(game.complete(1, 100, 0), false); assert.equal(errors.length, 1, "logged once");
  const second = game.teleport(1, POINT); game.teleport(1, POINT); await second; // superseded (status 1 later is silent)
  assert.equal(game.complete(1, 101, 1), false); assert.equal(errors.length, 1);
  const third = game.teleport(1, POINT); assert.equal(game.complete(1, 103, 0), true); assert.equal((await third).result, "ok");
});
