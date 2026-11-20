"use strict";

// Loads client/main.js in a vm sandbox with fake ArcaneMP client globals (fake Camera, Web, Events). No game.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepStrictEqual(plain(actual), plain(expected));
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "client", "main.js"), "utf8");

const GROUND = ["worldStatic", "shallowWater", "deepWater"];
const pose = (x, yaw = 0) => ({ position: { x, y: 2, z: 3 }, rotation: { pitch: -26.57, yaw, roll: 0 }, departure: { position: { x: x - 1000, y: 2, z: 903 }, rotation: { pitch: -30, yaw, roll: 0 } } });
const OPEN = { locations: [
  { id: "last", name: "Última localização", kind: "last", camera: pose(10) },
  { id: "hogsmeade", name: "Hogsmeade", kind: "config", camera: pose(20, 90) },
  { id: "patio", name: "Pátio", kind: "config", camera: pose(30) },
], flight: { durationMs: 1500, easing: "easeOut" }, areaTimeoutMs: 4000 };
const target = x => ({ position: { x, y: 2, z: 3 }, rotation: { pitch: -26.57, yaw: x === 20 ? 90 : 0, roll: 0 } });

function harness({ captureNull = false, activateThrows = false, animateThrows = false, activateResult = true, trace = null, visibility = () => true, position = () => ({ x: 7, y: 8, z: 9 }), emitThrows = false, logs = [], world = null, levelObjects = null, movement = {} } = {}) {
  const calls = [], handlers = {}, viewHandlers = {};
  let timers = [], nextTimer = 1, now = 1000, webBroken = false;
  const move = (name, args) => {
    calls.push([name, ...args]);
    const rule = movement[name];
    if (rule && rule.throws) throw new Error("boom");
    return typeof rule === "function" ? rule(...args) : true;
  };
  const camera = { active: false, playing: false };
  const Camera = {
    get active() { return camera.active; }, get playing() { return camera.playing; },
    capture: () => (captureNull ? null : { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 } }),
    activate(view, transition) { calls.push(["activate", view, transition]); if (activateThrows) throw new Error("boom"); camera.active = activateResult; return activateResult; },
    clearLookAt: () => calls.push(["clearLookAt"]),
    stop() { calls.push(["stop"]); camera.playing = false; },
    animateTo(view, options) { calls.push(["animateTo", view, options]); if (animateThrows) throw new Error("boom"); camera.playing = true; return true; },
    setPose(p) { calls.push(["setPose", p]); if (animateThrows) throw new Error("boom"); return true; },
    restore(transition) { calls.push(["restore", transition]); camera.active = false; },
  };
  const sandbox = {
    console: { log: line => logs.push(String(line)) }, Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ id, fn, at: now + ms }); return id; },
    clearTimeout: id => { timers = timers.filter(timer => timer.id !== id); },
    Events: { on: (name, fn) => { handlers[name] = fn; }, emitServer: (name, payload) => { if (emitThrows && name === "ms-spawn:select") throw new Error("boom"); calls.push(["emitServer", name, payload]); } },
    Web: { createView: (url, options) => { calls.push(["createView", url, options]); return 1; }, destroyView: () => calls.push(["destroyView"]),
      on: (_view, name, fn) => { viewHandlers[name] = fn; }, emit: (_view, name, payload) => { if (webBroken) throw new Error("boom"); calls.push(["emit", name, payload]); } },
    Camera,
    LocalPlayer: { setVisibility: visible => { calls.push(["setVisibility", visible]); return typeof visibility === "function" ? visibility(visible) : visibility; }, getPosition: () => position(),
      // CHG-07 fakes: each answers true unless movement.<name> says otherwise (a function result, or { throws: true })
      suspendGravity: () => move("suspendGravity", []), restoreGravity: () => move("restoreGravity", []),
      setCollision: enable => move("setCollision", [enable]), resetFall: () => move("resetFall", []) },
    ...(trace || world ? { World: { ...(trace ? { lineTrace: (start, end, options) => { calls.push(["lineTrace", start, end, options]); return trace(start, end, options); } } : {}), ...(world || {}) } } : {}),
    ...(levelObjects ? { LevelObjects: levelObjects } : {}),
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "client/main.js" });
  const advance = ms => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at; timers = timers.filter(timer => timer !== due); due.fn();
    }
    now = target;
  };
  const named = (...names) => calls.filter(call => names.includes(call[0]));
  const covers = () => calls.filter(call => call[0] === "emit" && call[1] === "cover").map(call => call[2]);
  const toPage = name => calls.filter(call => call[0] === "emit" && call[1] === name).map(call => call[2]);
  const server = name => calls.filter(call => call[0] === "emitServer" && call[1] === name).map(call => call[2]);
  const h = { breakWeb: () => { webBroken = true; }, Camera, calls, logs, advance, named, toPage, covers, server, camera, handlers, viewHandlers, clear: () => { calls.length = 0; },
    open: (payload = OPEN) => { handlers["ms-spawn:open"](payload); viewHandlers.ready(); },
    state: payload => handlers["ms-spawn:state"](payload),
    select: id => viewHandlers.select({ id }),
    get timerCount() { return timers.length; } };
  return h;
}
// Let the nominal flight finish: playing turns false after the duration.
const land = (h, ms = 1500) => { h.advance(ms - 50); h.camera.playing = false; h.advance(150); };
const hit = () => ({ distance: 700, startPenetrating: false });
// select + teleport done + ground hit: cover lifted, swoop playing
const lifted = (h, id) => { h.select(id); h.state({ status: "choosing", selectedId: id, teleport: "done" }); h.advance(300); };
// full path to the arrived state
const arrivedAt = (h, id) => { lifted(h, id); land(h); };

const stripped = list => list.map(({ id, name, kind, icon }) => ({ id, name, kind, ...(icon ? { icon } : {}) }));
const covered = (h, visible) => h.covers().at(-1)?.visible === visible;

// ---- view, forwarding ---------------------------------------------------------------------------------------------------
test("ms-spawn:open creates the view, forwards only id/name/kind to the page and takes no camera yet", () => {
  const h = harness(); h.open();
  same(h.named("createView")[0].slice(1), ["fw://resources/ms-spawn/client/ui/index.html", { focus: true }]);
  same(h.toPage("open"), [{ locations: stripped(OPEN.locations) }]);
  assert.equal(h.named("activate").length, 0);
  const text = JSON.stringify(h.toPage("open")); assert.equal(text.includes("position") || text.includes("departure"), false);
});
test("an open payload as a JSON string is accepted; malformed ones are ignored", () => {
  const h = harness(); h.handlers["ms-spawn:open"]("not json"); h.handlers["ms-spawn:open"]({ locations: "x" }); h.handlers["ms-spawn:open"](null);
  assert.equal(h.named("createView").length, 0);
  h.handlers["ms-spawn:open"](JSON.stringify(OPEN));
  assert.equal(h.named("createView").length, 1);
});
test("locations with a missing or non-finite camera are dropped", () => {
  const h = harness();
  h.handlers["ms-spawn:open"]({ locations: [{ id: "a", name: "A", camera: { position: { x: NaN, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 } } }, { id: "b", name: "B", camera: pose(1) }, { id: "c", name: "C" }] });
  h.viewHandlers.ready();
  same(h.toPage("open")[0].locations.map(l => l.id), ["b"]);
});
test("the client computes no targets: unknown ids are ignored and nothing covers", () => {
  const h = harness(); h.open(); h.clear();
  h.select("nowhere"); h.viewHandlers.select(null); h.viewHandlers.select({ id: 7 }); h.viewHandlers.select({ id: "x", camera: pose(5) });
  assert.equal(h.named("animateTo").length + h.server("ms-spawn:select").length + h.covers().length, 0);
});
test("the confirm from the page is forwarded as { id } only, for known ids", () => {
  const h = harness(); h.open(); h.clear();
  h.viewHandlers.confirm({ id: "patio", x: 1 }); h.viewHandlers.confirm({ id: "nowhere" }); h.viewHandlers.confirm(undefined);
  same(h.server("ms-spawn:confirm"), [{ id: "patio" }]);
});
test("the page state is flushed after the handshake when events arrived early", () => {
  const h = harness();
  h.handlers["ms-spawn:open"](OPEN); h.handlers["ms-spawn:state"]({ status: "choosing" });
  assert.equal(h.toPage("open").length, 0);
  h.viewHandlers.ready();
  assert.equal(h.toPage("open").length, 1); same(h.toPage("state"), [{ status: "choosing" }]);
});
test("SEC-03: the client acknowledges the page on ready and on every later open", () => {
  const h = harness(); h.handlers["ms-spawn:open"](OPEN);
  assert.equal(h.server("ms-spawn:opened").length, 0);
  h.viewHandlers.ready(); same(h.server("ms-spawn:opened"), [{}]);
  h.handlers["ms-spawn:open"](OPEN);
  assert.equal(h.server("ms-spawn:opened").length, 2);
});
test("server state is forwarded to the page; unknown statuses are ignored", () => {
  const h = harness(); h.open(); h.select("hogsmeade"); h.clear();
  h.state({ status: "choosing", selectedId: "hogsmeade", notice: "aviso", extra: 1 });
  same(h.toPage("state"), [{ status: "choosing", selectedId: "hogsmeade", notice: "aviso" }]);
  h.state({ status: "bogus" }); h.state(null);
  assert.equal(h.toPage("state").length, 1);
});

// ---- 04.05: cover state machine -----------------------------------------------------------------------------------------
test("04.05: the cover turns on in the same step as the select, which sends only { id }", () => {
  const h = harness(); h.open(); h.clear();
  h.viewHandlers.select({ id: "hogsmeade", x: 1, y: 2, z: 3, yaw: 4 });
  same(h.covers(), [{ visible: true, moment: "choosing" }]);
  same(h.server("ms-spawn:select"), [{ id: "hogsmeade" }]);
  assert.equal(h.named("animateTo").length, 0, "no flight under the cover");
});
test("04.05: teleport done + ground hit lifts the cover before the ceiling, with no notice", () => {
  let hits = 0;
  const h = harness({ trace: () => (++hits >= 2 ? hit() : null) });
  h.open(); h.select("hogsmeade");
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  assert.ok(covered(h, true));
  h.advance(300);
  same(h.covers(), [{ visible: true, moment: "choosing" }, { visible: false, moment: "choosing" }]);
  assert.equal(h.toPage("notice").length, 0);
  assert.equal(h.named("animateTo").length, 1);
});
test("04.05: no probe happens before the teleport result", () => {
  const h = harness({ trace: hit });
  h.open(); h.select("hogsmeade"); h.advance(2000);
  assert.equal(h.named("lineTrace").length, 0);
  same(h.covers(), [{ visible: true, moment: "choosing" }]);
});
test("04.05: the ceiling with teleport done is not a failure: cover lifts, swoop plays, no notice (decision 1)", () => {
  const h = harness({ trace: () => null });
  h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  h.advance(3700); assert.ok(covered(h, true));
  h.advance(500);
  assert.ok(covered(h, false));
  assert.equal(h.named("animateTo").length, 1); assert.equal(h.toPage("notice").length, 0);
});
test("04.05: a throwing World.lineTrace is caught: the cover lifts at the latest at the ceiling", () => {
  const h = harness({ trace: () => { throw new Error("boom"); } });
  h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  h.advance(3900); assert.ok(covered(h, true));
  h.advance(300); assert.ok(covered(h, false)); assert.equal(h.named("animateTo").length, 1);
});
test("04.05: a hit with startPenetrating does not count; the ceiling then ends the wait", () => {
  const h = harness({ trace: () => ({ startPenetrating: true }) });
  h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  h.advance(3000); assert.ok(covered(h, true));
  h.advance(1100); assert.ok(covered(h, false));
});
test("04.05: the probe uses the documented arguments at the target pose", () => {
  const h = harness({ trace: hit });
  h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  const [, start, end, options] = h.named("lineTrace")[0];
  same([start, end, options], [{ x: 20, y: 2, z: 103 }, { x: 20, y: 2, z: -19897 }, { objectTypes: GROUND }]); // CHG-05 (G19): from camera z+100, 20000 cm down
});
test("04.05: a new select restarts the ceiling for the new point; the old result never lifts the cover; the cover never toggles", () => {
  const h = harness({ trace: () => null });
  h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  h.advance(2000); h.select("patio");
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); // late result of A
  h.state({ status: "choosing", selectedId: "patio" });
  h.advance(3000); // 5000 ms after A, 3000 after B
  assert.equal(h.covers().filter(c => !c.visible).length, 0, "still covered");
  h.state({ status: "choosing", selectedId: "patio", teleport: "done" });
  h.advance(1100);
  same(h.covers(), [{ visible: true, moment: "choosing" }, { visible: false, moment: "choosing" }]);
  same(h.named("animateTo").map(c => c[1].position.x), [30]);
});
test("04.05: three selects 250 ms apart keep the cover on and lift it only for the last", () => {
  const h = harness({ trace: hit });
  h.open();
  h.select("hogsmeade"); h.advance(250); h.select("patio"); h.advance(250); h.select("last");
  same(h.server("ms-spawn:select").map(s => s.id), ["hogsmeade", "patio", "last"]);
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  h.state({ status: "choosing", selectedId: "patio", teleport: "done" });
  h.advance(500); assert.equal(h.covers().some(c => !c.visible), false);
  h.state({ status: "choosing", selectedId: "last", teleport: "done" });
  assert.equal(h.covers().filter(c => !c.visible).length, 1);
  same(h.named("animateTo").map(c => c[1].position.x), [10]);
});
test("04.05: clicks closer than the gap are coalesced (latest wins) and the cover is already on", () => {
  const h = harness(); h.open(); h.clear();
  h.select("hogsmeade"); h.advance(50); h.select("patio"); h.advance(50); h.select("last");
  assert.equal(h.server("ms-spawn:select").length, 1);
  h.advance(400);
  same(h.server("ms-spawn:select"), [{ id: "hogsmeade" }, { id: "last" }]);
  assert.equal(h.covers().filter(c => c.visible).length, 1);
});
for (const [name, signal] of [["teleport failed signal", s => s.state({ status: "choosing", selectedId: "hogsmeade", teleport: "failed", notice: "do servidor" })],
  ["ceiling without the teleport result (timeout)", s => s.advance(4300)]]) {
  test("04.05: " + name + ": cover lifts, notice, camera not moved or restored, no arrived", () => {
    const h = harness({ trace: hit });
    h.open(); h.select("hogsmeade"); h.clear();
    signal(h);
    same(h.covers(), [{ visible: false, moment: "choosing" }]);
    assert.equal(h.toPage("notice").length, 1);
    assert.equal(h.named("animateTo").length + h.named("restore").length, 0);
    assert.equal(h.server("ms-spawn:arrived").length, 0); assert.equal(h.timerCount, 0);
    assert.equal(h.toPage("state").some(s => s.notice), false, "the failure notice travels with the cover, not as a state notice");
  });
}
test("04.05: a timeout failure shows the pt-PT preparation notice", () => {
  const h = harness(); h.open(); h.select("hogsmeade"); h.advance(4300);
  same(h.toPage("notice"), [{ text: "Não foi possível preparar este local. Tenta de novo ou escolhe outro local." }]);
});
test("04.05: after a failure the same id (or another) retries: cover on again, a fresh ceiling", () => {
  const h = harness({ trace: hit });
  h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "failed", notice: "x" }); h.clear();
  h.advance(300); h.select("hogsmeade");
  same(h.server("ms-spawn:select"), [{ id: "hogsmeade" }]);
  same(h.covers(), [{ visible: true, moment: "choosing" }]);
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  assert.ok(covered(h, false)); assert.equal(h.named("animateTo").length, 1);
});
test("04.05: a notice state while covering re-asserts the cover (the page lifts it on any notice)", () => {
  const h = harness(); h.open(); h.select("hogsmeade"); h.clear();
  h.state({ status: "choosing", selectedId: "hogsmeade", notice: "Aguarda antes de repetir." });
  same(h.covers(), [{ visible: true, moment: "choosing" }]);
});
test("04.05: when the server holds another selection than the client's, the client follows the server", () => {
  const h = harness(); h.open(); h.select("hogsmeade"); h.advance(100); h.clear();
  h.state({ status: "choosing", selectedId: "patio", notice: "Aguarda antes de repetir." });
  same(h.named("setPose").map(c => c[1].position.x), [pose(30).departure.position.x]);
});
test("04.05: Camera failures while covering lift the cover, release the camera and notify", () => {
  for (const options of [{ activateThrows: true }, { activateResult: false }, { captureNull: true }]) {
    const h = harness({ ...options, trace: hit }); h.open(); h.clear(); h.select("hogsmeade");
    assert.ok(covered(h, false), JSON.stringify(options));
    assert.equal(h.toPage("notice").length, 1); assert.equal(h.server("ms-spawn:arrived").length, 0);
    assert.equal(h.timerCount, 0);
  }
});
for (const [exit, run] of [["closed", h => h.state({ status: "closed" })], ["resource stop", h => h.handlers.resourceStop("ms-spawn")],
  ["a session lost (closed with a notice)", h => h.state({ status: "closed", notice: "perdida" })]]) {
  test("04.05: " + exit + " lifts the cover, stops the wait and gives the camera back", () => {
    const h = harness({ trace: () => null });
    h.open(); h.select("hogsmeade"); h.advance(250); h.clear();
    run(h);
    assert.ok(covered(h, false));
    assert.equal(h.timerCount, 0); assert.equal(h.named("restore").length, 1);
    const traces = h.named("lineTrace").length; h.advance(20000); assert.equal(h.named("lineTrace").length, traces);
  });
}

// ---- 04.06: departure pose and swoop ------------------------------------------------------------------------------------
test("04.06: under the cover the camera is parked at camera.departure without animation; arguments come only from the payload", () => {
  const h = harness(); h.open(); h.clear();
  h.select("hogsmeade");
  const [, view, transition] = h.named("activate")[0];
  same(view.position, pose(20, 90).departure.position); same(view.rotation, pose(20, 90).departure.rotation); same(transition, { duration: 0 });
  assert.equal(h.named("animateTo").length, 0); assert.equal(h.covers()[0].visible, true);
});
test("04.06: a second select re-places the camera with setPose (the camera stays active)", () => {
  const h = harness(); h.open(); h.select("hogsmeade"); h.advance(300); h.select("patio");
  assert.equal(h.named("activate").length, 1);
  same(h.named("setPose")[0][1], pose(30).departure);
  assert.equal(h.named("stop").length, 1);
});
test("04.06: when the cover lifts the swoop runs to the target pose with the flight settings, after the lift", () => {
  const h = harness({ trace: hit }); h.open(); h.select("hogsmeade");
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  same(h.named("animateTo")[0].slice(1), [target(20), { duration: 1.5, easing: "easeOut" }]);
  same(h.toPage("camera"), [{ status: "flying", id: "hogsmeade" }]);
  const order = h.calls.map(c => (c[0] === "emit" && c[1] === "cover" && !c[2].visible ? "lift" : c[0])).filter(n => n === "lift" || n === "animateTo");
  same(order, ["lift", "animateTo"]);
});
test("04.06: arrived is sent exactly once per swoop and the page is told; streaming is never sent", () => {
  const h = harness({ trace: hit }); h.open(); lifted(h, "hogsmeade"); h.clear();
  land(h);
  same(h.server("ms-spawn:arrived"), [{ id: "hogsmeade" }]);
  same(h.toPage("camera"), [{ status: "arrived", id: "hogsmeade" }]);
  h.advance(20000); assert.equal(h.server("ms-spawn:arrived").length, 1); assert.equal(h.timerCount, 0);
});
test("04.06: a select during the swoop cancels it, covers again and the old swoop never reports arrival", () => {
  const h = harness({ trace: hit }); h.open(); lifted(h, "hogsmeade"); h.advance(300); h.clear();
  h.select("patio");
  assert.equal(h.covers()[0].visible, true);
  h.advance(2000);
  assert.equal(h.server("ms-spawn:arrived").length, 0);
  h.state({ status: "choosing", selectedId: "patio", teleport: "done" }); land(h);
  same(h.server("ms-spawn:arrived"), [{ id: "patio" }]);
});
test("04.06: a flight that never reports playing still ends at its nominal duration; a stuck Camera.playing is capped", () => {
  const h = harness({ trace: hit }); h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); h.camera.playing = false;
  h.advance(1000); assert.equal(h.server("ms-spawn:arrived").length, 0);
  h.advance(700); assert.equal(h.server("ms-spawn:arrived").length, 1);
  const g = harness({ trace: hit }); g.open(); g.select("hogsmeade");
  g.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); g.advance(300);
  g.camera.playing = true; g.advance(1500 + 3000 + 300);
  assert.equal(g.server("ms-spawn:arrived").length, 1);
});
test("04.06: a throwing swoop restores the camera, lifts the cover with the notice and sends no arrived", () => {
  const h = harness({ trace: hit });
  h.open(); h.select("hogsmeade");
  h.Camera.animateTo = () => { throw new Error("boom"); }; h.clear();
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  assert.equal(h.named("restore").length, 1); assert.ok(covered(h, false));
  assert.equal(h.toPage("notice").length, 1); assert.equal(h.server("ms-spawn:arrived").length, 0);
});
test("04.06: losing the camera mid swoop fails it instead of waiting forever", () => {
  const h = harness({ trace: hit }); h.open(); lifted(h, "hogsmeade"); h.clear();
  h.camera.active = false; h.advance(200);
  same(h.toPage("camera"), [{ status: "arrived", id: "hogsmeade" }]);
  assert.equal(h.named("restore").length, 0); assert.equal(h.timerCount, 0); assert.equal(h.server("ms-spawn:arrived").length, 0);
});
test("04.06: no target comes from a client calculation: every camera argument is a payload value", () => {
  const h = harness({ trace: hit }); h.open(); h.select("patio");
  h.state({ status: "choosing", selectedId: "patio", teleport: "done" });
  const payload = JSON.stringify(OPEN.locations[2].camera);
  for (const call of h.named("activate", "setPose", "animateTo")) {
    const arg = call[1];
    assert.ok(payload.includes(JSON.stringify(arg.position)) && payload.includes(JSON.stringify(arg.rotation)), JSON.stringify(arg));
  }
});

// ---- 04.04: own body ----------------------------------------------------------------------------------------------------
const visibilityCalls = h => h.named("setVisibility").map(c => c[1]);
test("04.04: the body is hidden once when the page opens", () => {
  const h = harness(); h.open();
  same(visibilityCalls(h), [false]);
  h.handlers["ms-spawn:open"](OPEN); // a re-open keeps it hidden without a second call
  same(visibilityCalls(h), [false]);
});
test("04.04: without a pawn the hide is retried on a fixed schedule and gives up at the limit, page still usable", () => {
  let pawn = false;
  const h = harness({ visibility: () => pawn });
  h.open(); same(visibilityCalls(h), [false]);
  h.advance(250 * 3); assert.equal(visibilityCalls(h).length, 4);
  pawn = true; h.advance(250); assert.equal(visibilityCalls(h).length, 5);
  h.advance(10000); assert.equal(visibilityCalls(h).length, 5);
  const g = harness({ visibility: () => false }); g.open(); g.advance(60000);
  assert.equal(visibilityCalls(g).length, 40); assert.equal(g.timerCount, 0);
  g.select("hogsmeade"); assert.equal(g.covers().length, 1);
});
test("04.04: setVisibility throwing is caught: the page opens and the camera is not stuck", () => {
  const h = harness({ visibility: () => { throw new Error("boom"); } }); h.open();
  assert.equal(h.named("createView").length, 1); h.select("hogsmeade"); assert.equal(h.named("activate").length, 1);
});
test("04.04: the body stays hidden through flights and covers and is shown once on success, after the final fade", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" });
  same(visibilityCalls(h), [false]);
  h.state({ status: "closed" }); h.advance(100);
  same(visibilityCalls(h), [false]);
  h.advance(400);
  same(visibilityCalls(h), [false, true]);
});
for (const [exit, run] of [["a cancelled selection (closed, not applying)", h => h.state({ status: "closed" })], ["a session lost", h => h.state({ status: "closed", notice: "x" })],
  ["resource stop", h => h.handlers.resourceStop("ms-spawn")]]) {
  test("04.04: " + exit + " restores the body, once, idempotently", () => {
    const h = harness({ trace: hit }); h.open(); h.select("hogsmeade"); h.clear();
    run(h); run(h); h.handlers.resourceStop("ms-spawn");
    same(visibilityCalls(h), [true]);
  });
}
test("04.04: a camera error exit leaves the page usable and the body hidden until a real exit, which restores it", () => {
  const h = harness({ trace: hit, animateThrows: true }); h.open(); h.select("hogsmeade");
  same(visibilityCalls(h), [false]);
  h.state({ status: "closed" }); same(visibilityCalls(h), [false, true]);
});
test("04.04: a crash inside a handler ends the selection: cover lifted, camera and body restored, page closed", () => {
  const h = harness({ trace: hit, emitThrows: true }); h.open();
  h.select("hogsmeade");
  assert.ok(covered(h, false)); assert.equal(h.named("destroyView").length, 1);
  same(visibilityCalls(h), [false, true]); assert.equal(h.timerCount, 0);
});

// ---- 04.07: confirm cover, final world, fade, close --------------------------------------------------------------------
test("04.07: confirm covers again in the same step and sends only { id }", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade"); h.clear();
  h.viewHandlers.confirm({ id: "hogsmeade", x: 1 });
  same(h.covers(), [{ visible: true, moment: "confirm" }]);
  same(h.server("ms-spawn:confirm"), [{ id: "hogsmeade" }]);
});
test("04.07: a server rejection lifts the confirm cover and keeps body, camera and selection", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.clear();
  h.state({ status: "choosing", selectedId: "hogsmeade", notice: "O servidor rejeitou este local." });
  same(h.covers(), [{ visible: false, moment: "confirm" }]);
  assert.equal(h.named("restore").length + h.named("setVisibility").length + h.named("destroyView").length, 0);
  h.viewHandlers.confirm({ id: "hogsmeade" }); // a second confirm works
  assert.equal(h.server("ms-spawn:confirm").length, 1);
});
test("04.07: a confirm the server never answers does not keep the screen covered", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.advance(5100);
  assert.ok(covered(h, false)); assert.equal(h.timerCount, 0);
});
test("04.07: after closed, the cover waits for the final world, then fades; camera, body and page close only afterwards", () => {
  let traced = 0, instant = true;
  const h = harness({ trace: () => (instant || ++traced >= 3 ? hit() : null) });
  h.open(); arrivedAt(h, "hogsmeade"); instant = false;
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); h.clear();
  h.state({ status: "closed" });
  assert.equal(h.named("destroyView").length, 0); assert.equal(h.covers().some(c => !c.visible), false);
  same(h.named("lineTrace")[0].slice(1, 3), [{ x: 7, y: 8, z: 109 }, { x: 7, y: 8, z: -19891 }]); // the local player's own position
  h.advance(500);
  same(h.covers().at(-1), { visible: false, moment: "confirm" });
  assert.equal(h.named("restore").length + h.named("destroyView").length, 0, "not before the fade");
  assert.equal(h.named("setVisibility").length, 0);
  h.advance(199); assert.equal(h.named("destroyView").length, 0);
  h.advance(60);
  same(h.named("restore")[0], ["restore", { duration: 1 }]);
  assert.equal(h.named("destroyView").length, 1); same(visibilityCalls(h), [true]);
  assert.equal(h.timerCount, 0);
});
test("04.07: the ceiling in the final wait is not a failure: no notice, fade then close", () => {
  const h = harness({ trace: () => null });
  h.open(); h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); h.clear();
  h.state({ status: "closed" }); h.advance(3900); assert.equal(h.named("destroyView").length, 0);
  h.advance(400); assert.ok(covered(h, false)); h.advance(300);
  assert.equal(h.named("destroyView").length, 1); assert.equal(h.toPage("notice").length, 0);
});
test("04.07: no pawn position (null) or a throwing trace is handled by the ceiling", () => {
  for (const options of [{ position: () => null, trace: hit }, { trace: () => { throw new Error("boom"); } }]) {
    const h = harness(options);
    h.open(); h.state({ status: "applying", selectedId: "hogsmeade" }); h.state({ status: "closed" });
    h.advance(4200); assert.ok(covered(h, false)); h.advance(300); assert.equal(h.named("destroyView").length, 1);
  }
});
test("04.07: resource stop while the final cover is up lifts at once and restores camera and body", () => {
  const h = harness({ trace: () => null }); h.open(); h.select("hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); h.state({ status: "closed" }); h.clear();
  h.handlers.resourceStop("ms-spawn");
  assert.ok(covered(h, false)); assert.equal(h.named("destroyView").length, 1); same(visibilityCalls(h), [true]);
  assert.equal(h.timerCount, 0);
});
test("04.07: if ms-character never closes, the apply ceiling lifts and closes the page", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" });
  h.advance(60000); assert.ok(covered(h, false)); h.advance(300);
  assert.equal(h.named("destroyView").length, 1); same(visibilityCalls(h), [false, true]);
});
test("04.07: the client sends nothing the server could use as an authorisation", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); h.state({ status: "closed" }); h.advance(2000);
  same(h.named("emitServer").map(call => call[1]), ["ms-spawn:opened", "ms-spawn:select", "ms-spawn:arrived", "ms-spawn:confirm"]);
});
test("a re-open (selection restarted) hands the camera back, keeps the body hidden and drops the cover", () => {
  const h = harness({ trace: () => null }); h.open(); h.select("hogsmeade"); h.clear();
  h.handlers["ms-spawn:open"](OPEN);
  assert.equal(h.named("restore").length, 1); assert.equal(h.named("createView").length, 0);
  assert.equal(h.timerCount, 0); assert.equal(h.named("setVisibility").length, 0);
  h.select("patio"); assert.ok(covered(h, true));
});
test("a missing departure (older server) falls back to the target pose without computing anything", () => {
  const h = harness();
  h.handlers["ms-spawn:open"]({ locations: [{ id: "a", name: "A", camera: { position: { x: 1, y: 2, z: 3 }, rotation: { pitch: 0, yaw: 0, roll: 0 } } }] });
  h.viewHandlers.ready(); h.select("a");
  same(h.named("activate")[0][1].position, { x: 1, y: 2, z: 3 });
});
test("the source calls World.lineTrace and keeps no null-returning areaLoaded seam", () => {
  assert.equal(/function areaLoaded\(\) \{ return null/.test(SOURCE), false);
  assert.ok(SOURCE.includes("World.lineTrace"));
});

// ---- Section 9 re-gate (SEC-11, SEC-12, SEC-14) -------------------------------------------------------------------------
test("SEC-11: a confirm the server never answers puts the page back in choosing with a retry notice, so the list unlocks", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.clear(); h.advance(5100);
  same(h.covers(), [{ visible: false, moment: "confirm" }]);
  const states = h.toPage("state"); assert.equal(states.length, 1);
  assert.equal(states[0].status, "choosing"); assert.equal(states[0].selectedId, "hogsmeade");
  assert.equal(typeof states[0].notice, "string"); assert.ok(states[0].notice.length > 0);
  h.clear(); h.viewHandlers.confirm({ id: "hogsmeade" }); // a retry is possible and covers again
  same(h.server("ms-spawn:confirm"), [{ id: "hogsmeade" }]); same(h.covers(), [{ visible: true, moment: "confirm" }]);
});
test("SEC-11: an answered confirm sends no retry state when the ack timer would have fired", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); h.clear(); h.advance(5100);
  assert.equal(h.toPage("state").length, 0);
});
test("SEC-12: an emergency teardown also sends ms-spawn:abandon (no payload), after restoring camera, body and page", () => {
  const h = harness({ trace: hit, emitThrows: true }); h.open();
  h.select("hogsmeade");
  assert.equal(h.named("destroyView").length, 1); same(visibilityCalls(h), [false, true]);
  same(h.server("ms-spawn:abandon"), [{}]);
});
test("SEC-12: regular exits (closed, resource stop) never send abandon", () => {
  const a = harness({ trace: hit }); a.open(); a.state({ status: "closed" });
  const b = harness({ trace: hit }); b.open(); b.handlers.resourceStop("ms-spawn");
  for (const h of [a, b]) assert.equal(h.server("ms-spawn:abandon").length, 0);
});
test("SEC-14: a MOVE_LIMIT-style notice (old id + teleport done) lifts the cover without waiting for the ceiling, no false failure", () => {
  const h = harness({ trace: hit }); h.open(); lifted(h, "hogsmeade"); land(h);
  h.select("patio"); h.advance(300); h.clear();
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done", notice: "Mudaste de local demasiadas vezes. Confirma o local atual." });
  h.advance(300);
  assert.ok(covered(h, false), "cover lifted");
  assert.equal(h.named("animateTo").length, 1);
  assert.equal(h.toPage("notice").length, 0, "no preparation failure");
  h.advance(5000); assert.equal(h.toPage("notice").length, 0);
});
test("SEC-14: the same restart with teleport failed ends at once with the preparation notice", () => {
  const h = harness({ trace: hit }); h.open(); lifted(h, "hogsmeade"); land(h);
  h.select("patio"); h.advance(300); h.clear();
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "failed", notice: "Aguarda antes de repetir." });
  assert.ok(covered(h, false)); assert.equal(h.toPage("notice").length, 1);
});

// ---- CHG-03: timing line ------------------------------------------------------------------------------------------------
const timed = (extra = {}) => ({ ...OPEN, timingLog: true, ...extra });
const timingLines = h => h.logs.filter(line => line.startsWith("[ms-spawn] timing"));
test("CHG-03: one timing line when the cover lifts on a ground hit, with the experimental fields marked", () => {
  let hits = 0;
  const h = harness({ trace: () => (++hits >= 2 ? hit() : null), world: { isReady: () => true, generation: () => 7 }, levelObjects: { near: opts => { assert.deepEqual(plain(opts), { radius: 2000 }); return [1, 2, 3]; } } });
  h.open(timed()); h.select("hogsmeade");
  h.advance(100); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); h.advance(300);
  const lines = timingLines(h);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[ms-spawn\] timing select=hogsmeade toTeleportDoneMs=100 toGroundHitMs=\d+ toCoverLiftMs=\d+ ceiling=false experimental: worldReady=true worldGeneration=7 nearObjects=3$/);
  assert.doesNotMatch(lines[0], /position|x=|y=|z=/);
});
test("CHG-03: a ceiling with the teleport done logs ceiling=true and toGroundHitMs=null; the page never gets the flag", () => {
  const h = harness({ trace: () => null });
  h.open(timed()); h.select("hogsmeade");
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); h.advance(4300);
  const lines = timingLines(h);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /toGroundHitMs=null .* ceiling=true/);
  assert.equal(JSON.stringify(h.toPage("open")).includes("timingLog"), false);
});
test("CHG-03: a missing World/LevelObjects only costs the experimental fields, never the lift or the swoop", () => {
  const h = harness({ trace: hit });
  h.open(timed()); h.select("hogsmeade");
  h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); h.advance(300);
  assert.equal(h.named("animateTo").length, 1);
  assert.equal(timingLines(h).length, 1);
});
test("CHG-03: no timing line when the flag is false or absent (older server)", () => {
  for (const open of [timed({ timingLog: false }), OPEN]) {
    const h = harness({ trace: hit });
    h.open(open); h.select("hogsmeade");
    h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); h.advance(300);
    assert.equal(timingLines(h).length, 0);
    assert.equal(h.named("animateTo").length, 1);
  }
});
test("CHG-03: a ceiling without the teleport result also logs once, with toTeleportDoneMs=null", () => {
  const h = harness({ trace: hit });
  h.open(timed()); h.select("hogsmeade"); h.advance(4300);
  const lines = timingLines(h);
  assert.equal(lines.length, 1); assert.match(lines[0], /toTeleportDoneMs=null toGroundHitMs=null .* ceiling=true/);
});

// ---- CHG-05: icon forwarding and the deeper ground probe ---------------------------------------------------------------------
test("04.08/05.11: a valid icon is forwarded to the page with id, name and kind; last never gets one", () => {
  const h = harness();
  h.open({ ...OPEN, locations: [{ ...OPEN.locations[0], icon: "star.png" }, { ...OPEN.locations[1], icon: "hogsmeade.webp" }, OPEN.locations[2]] });
  same(h.toPage("open")[0].locations, [{ id: "last", name: "Última localização", kind: "last" }, { id: "hogsmeade", name: "Hogsmeade", kind: "config", icon: "hogsmeade.webp" }, { id: "patio", name: "Pátio", kind: "config" }]);
});
test("04.08/05.11: an icon that is not a plain file name is dropped before it reaches the page", () => {
  const bad = ["../x.png", "a/b.png", "x.gif", "X.png", "x.png?a=1", "http://x/y.png", "", 5, null, ["a.png"], "a".repeat(61) + ".png"];
  for (const icon of bad) {
    const h = harness(); h.open({ ...OPEN, locations: [{ ...OPEN.locations[1], icon }] });
    same(h.toPage("open")[0].locations, [{ id: "hogsmeade", name: "Hogsmeade", kind: "config" }]);
  }
});
test("04.08/05.11: nothing but id, name, kind and icon reaches the page (no camera, no lookAt, no spawn point, no role)", () => {
  const h = harness();
  h.open({ ...OPEN, locations: [{ ...OPEN.locations[1], icon: "a.png", role: "r", lookAt: { x: 1, y: 2, z: 3 }, x: 5, y: 6, z: 7, yaw: 8 }] });
  same(Object.keys(h.toPage("open")[0].locations[0]).sort(), ["icon", "id", "kind", "name"]);
});
test("04.08: the probe runs below the camera position and a camera well above the ground still hits (deeper than the old z-10000)", () => {
  const h = harness({ trace: (start, end) => (end.z <= -15000 ? hit() : null) });
  h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  const [, start, end] = h.named("lineTrace")[0];
  same([start.x, start.y, start.z, end.x, end.y], [20, 2, 103, 20, 2]);
  assert.ok(end.z < -10000, "deeper than the previous end");
  assert.ok(covered(h, false), "the cover lifted on the deep hit, not on the ceiling");
  assert.equal(h.named("animateTo").length, 1);
});
test("04.08: the client source does not know the spawn point, lookAt or the role", () => {
  assert.equal(/lookAt|\.role|destination/.test(SOURCE.replace(/\/\/.*$/gm, "")), false);
});

// ---- CHG-07 (04.09, 04.10): no collision and no gravity while choosing -------------------------------------------------------
const MOVE = ["suspendGravity", "setCollision", "resetFall", "restoreGravity"];
const moveCalls = h => h.named(...MOVE).map(call => (call[0] === "setCollision" ? "setCollision(" + call[1] + ")" : call[0]));
const RESTORE = ["resetFall", "setCollision(true)", "restoreGravity"];
const indexOf = (h, name, arg) => h.calls.findIndex(call => call[0] === name && (arg === undefined || call[1] === arg));
const coverLift = h => h.calls.findIndex(call => call[0] === "emit" && call[1] === "cover" && call[2].visible === false);

test("04.09: open suspends gravity and turns collision off once, next to hiding the body", () => {
  const h = harness(); h.open();
  same(moveCalls(h), ["suspendGravity", "setCollision(false)"]);
  assert.equal(h.named("setVisibility").length, 1);
});
test("04.09: with no pawn the calls are retried on the fixed schedule until they succeed, settled ones are not repeated", () => {
  let tries = 0;
  const h = harness({ visibility: () => ++tries > 2, movement: { setCollision: enable => (enable === false ? tries > 2 : true) } });
  h.open();
  assert.equal(h.named("setCollision").length, 1);
  h.advance(250 * 3);
  assert.equal(h.named("setCollision").length, 3, "retried until it answered true");
  assert.equal(h.named("suspendGravity").length, 1, "gravity answers true at once and is not repeated");
  h.advance(5000); assert.equal(h.named("setCollision").length, 3); assert.equal(h.timerCount, 0);
});
test("04.09: without a pawn forever, the retry stops at the limit with one warning and the page stays usable", () => {
  const h = harness({ visibility: false, movement: { setCollision: () => false } }); h.open();
  h.advance(250 * 60);
  assert.equal(h.named("setCollision").length, 40);
  assert.equal(h.logs.filter(line => line.includes("could not be set")).length, 1);
  h.select("hogsmeade"); assert.equal(covered(h, true), true);
});
test("04.09: re-selects and a re-open do not suspend or switch collision off again", () => {
  const h = harness({ trace: hit }); h.open(); h.select("hogsmeade"); h.advance(300); h.select("patio"); h.advance(300); h.handlers["ms-spawn:open"](OPEN);
  same(moveCalls(h), ["suspendGravity", "setCollision(false)"]);
});
test("04.09: a throwing native is logged once, never blocks the open, is not retried, and the restore still runs in order", () => {
  const h = harness({ movement: { suspendGravity: { throws: true }, setCollision: { throws: true } } });
  h.open(); h.advance(5000);
  assert.equal(h.named("suspendGravity").length, 1); assert.equal(h.named("setCollision").length, 1);
  assert.equal(h.logs.filter(line => line.includes("suspendGravity failed")).length, 1);
  assert.equal(h.named("createView").length, 1);
  h.clear(); h.state({ status: "closed" });
  same(moveCalls(h), ["resetFall", "setCollision(true)", "restoreGravity"]);
});
{
  const exits = {
    "a cancel (closed without applying)": h => h.state({ status: "closed" }),
    "closed after a select, not applying": h => { h.select("hogsmeade"); h.state({ status: "closed" }); },
    "resource stop": h => h.handlers.resourceStop("ms-spawn"),
  };
  for (const [name, exit] of Object.entries(exits)) {
    test("04.09: " + name + " restores movement in order, before camera and body, once", () => {
      const h = harness({ trace: hit }); h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" }); h.advance(300); h.clear();
      exit(h);
      same(moveCalls(h), RESTORE);
      assert.ok(indexOf(h, "resetFall") < indexOf(h, "restore"), "movement before camera");
      assert.ok(indexOf(h, "resetFall") < indexOf(h, "setVisibility", true), "movement before body");
      h.state({ status: "closed" }); h.handlers.resourceStop("ms-spawn");
      same(moveCalls(h), RESTORE);
    });
  }
}
test("04.09: an emergency teardown restores movement before camera and body and sends abandon", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade"); h.clear();
  h.handlers["ms-spawn:state"]({ status: "choosing", selectedId: "hogsmeade", get notice() { throw new Error("boom"); } });
  same(moveCalls(h), RESTORE);
  assert.ok(indexOf(h, "resetFall") < indexOf(h, "restore"));
  assert.ok(indexOf(h, "resetFall") < indexOf(h, "setVisibility", true));
  assert.equal(h.server("ms-spawn:abandon").length, 1);
});
test("04.09: the 5 s unanswered-confirm guard restores in order; a later exit adds nothing", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade"); h.clear();
  h.viewHandlers.confirm({ id: "hogsmeade" }); assert.equal(moveCalls(h).length, 0, "not at the click");
  h.advance(5000);
  same(moveCalls(h), RESTORE);
  h.handlers.resourceStop("ms-spawn"); same(moveCalls(h), RESTORE);
});
test("04.09: the 60 s apply ceiling restores in order before the cover lifts", () => {
  const h = harness({ trace: () => null }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); h.clear();
  h.advance(60000);
  same(moveCalls(h), RESTORE);
  assert.ok(coverLift(h) > indexOf(h, "restoreGravity"));
  h.handlers.resourceStop("ms-spawn"); same(moveCalls(h), RESTORE);
});
test("04.09: throwing restore calls do not skip the rest, nor the camera, body or page", () => {
  const h = harness({ trace: hit, movement: { resetFall: { throws: true } } }); h.open(); arrivedAt(h, "hogsmeade"); h.clear();
  h.handlers.resourceStop("ms-spawn");
  same(moveCalls(h), RESTORE);
  assert.equal(h.named("restore").length, 1); assert.equal(h.named("setVisibility").length, 1); assert.equal(h.named("destroyView").length, 1);
});
// SEC-17: a throwing Web.emit (the cover lift) must not skip any restore
for (const [name, exit] of [["normal closed", h => h.state({ status: "closed" })], ["resource stop", h => h.handlers.resourceStop("ms-spawn")]]) {
  test("SEC-17: Web.emit throwing during teardown (" + name + ") still restores movement, camera and body once", () => {
    const h = harness({ trace: () => null }); h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
    assert.equal(covered(h, true), true, "a cover is up");
    h.clear(); h.breakWeb();
    exit(h);
    same(moveCalls(h), RESTORE);
    assert.equal(h.named("restore").length, 1); assert.equal(h.named("setVisibility").filter(call => call[1] === true).length, 1);
    assert.equal(h.named("destroyView").length, 1);
    h.state({ status: "closed" }); h.handlers.resourceStop("ms-spawn");
    same(moveCalls(h), RESTORE);
  });
}
test("SEC-17: Web.emit throwing in an emergency teardown still restores movement, camera and body once", () => {
  const h = harness({ trace: () => null }); h.open(); h.select("hogsmeade");
  assert.equal(covered(h, true), true);
  h.clear(); h.breakWeb();
  h.handlers["ms-spawn:state"]({ status: "choosing", selectedId: "hogsmeade", get notice() { throw new Error("boom"); } });
  same(moveCalls(h), RESTORE);
  assert.equal(h.named("restore").length, 1); assert.equal(h.named("setVisibility").filter(call => call[1] === true).length, 1);
  assert.equal(h.server("ms-spawn:abandon").length, 1);
});
test("04.09: nothing about movement or collision is sent to the server or the page", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade"); h.viewHandlers.confirm({ id: "hogsmeade" });
  const text = JSON.stringify(h.calls.filter(call => call[0] === "emitServer" || call[0] === "emit"));
  assert.equal(/collision|gravity|resetFall|movement/i.test(text), false);
});

test("04.10: no restore at the click nor while the server applies; it comes after closed and the final world, before the cover lifts", () => {
  let ground = true;
  const h = harness({ trace: () => (ground ? hit() : null) }); h.open(); arrivedAt(h, "hogsmeade"); h.clear(); ground = false;
  h.viewHandlers.confirm({ id: "hogsmeade" }); assert.equal(moveCalls(h).length, 0);
  h.state({ status: "applying", selectedId: "hogsmeade" }); assert.equal(moveCalls(h).length, 0);
  h.advance(10000); assert.equal(moveCalls(h).length, 0, "still applying");
  h.state({ status: "closed" });
  assert.equal(moveCalls(h).length, 0, "closed alone: the final world is not loaded yet");
  h.advance(300); assert.equal(moveCalls(h).length, 0); ground = true;
  h.advance(300);
  same(moveCalls(h), RESTORE);
  assert.ok(coverLift(h) > indexOf(h, "restoreGravity"), "restored with the cover still opaque");
  assert.equal(indexOf(h, "setVisibility", true), -1, "body not shown yet");
  assert.equal(h.named("restore").length, 0, "camera not restored yet");
  h.advance(300);
  assert.ok(indexOf(h, "setVisibility", true) > coverLift(h));
  same(moveCalls(h), RESTORE);
  h.handlers.resourceStop("ms-spawn"); same(moveCalls(h), RESTORE);
});
test("04.10: the ceiling in the final wait restores anyway, before the fade, with no notice", () => {
  const h = harness({ trace: () => null }); h.open(); h.select("hogsmeade"); h.state({ status: "choosing", selectedId: "hogsmeade", teleport: "done" });
  h.advance(4000); land(h);
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); h.state({ status: "closed" }); h.clear();
  h.advance(3700); assert.equal(moveCalls(h).length, 0);
  h.advance(500); same(moveCalls(h), RESTORE);
  assert.equal(h.toPage("notice").length, 0);
});
test("04.10: a throwing lineTrace in the final wait is caught; the restore comes by the ceiling, before the cover lifts", () => {
  let armed = false;
  const h = harness({ trace: () => { if (armed) throw new Error("boom"); return hit(); } }); h.open(); arrivedAt(h, "hogsmeade");
  h.viewHandlers.confirm({ id: "hogsmeade" }); h.state({ status: "applying", selectedId: "hogsmeade" }); armed = true; h.state({ status: "closed" }); h.clear();
  h.advance(3000); assert.equal(moveCalls(h).length, 0);
  h.advance(1500); same(moveCalls(h), RESTORE);
  assert.ok(coverLift(h) > indexOf(h, "restoreGravity"));
});
test("04.10: a server rejection after confirm keeps collision and gravity as they were and the view usable", () => {
  const h = harness({ trace: hit }); h.open(); arrivedAt(h, "hogsmeade"); h.clear();
  h.viewHandlers.confirm({ id: "hogsmeade" });
  h.state({ status: "choosing", selectedId: "hogsmeade", notice: "Ainda não" });
  assert.equal(moveCalls(h).length, 0);
  h.advance(6000); assert.equal(moveCalls(h).length, 0, "the 5 s guard was cancelled by the answer");
  h.select("patio"); assert.equal(covered(h, true), true);
  assert.equal(moveCalls(h).length, 0);
});
