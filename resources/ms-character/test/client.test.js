"use strict";

// Loads client/main.js in a vm sandbox with fake ArcaneMP client globals. No game, no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Objects cross a vm realm boundary, so compare their JSON form.
const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepStrictEqual(plain(actual), plain(expected));

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "client", "main.js"), "utf8");

function harness({ screenWidth = 1920, beginResult = true, schemaReadyAfterPolls = 0, importThrows = false, groundAfterPolls = 0, groundThrows = false } = {}) {
  const calls = [];
  const log = (name, ...args) => calls.push([name, ...args]);
  const handlers = {};
  const viewHandlers = {};
  let timers = [], nextTimer = 1, now = 0;
  let active = false, groundPolls = 0, polls = 0, schemaGender = 0, appliedPreset = null;
  const account = { format: "arcanemp-look", gender: "male", pronoun: "wizard", presets: { hairStyle: "account" } };
  let current = account;

  const Creator = {
    exportLook: () => { log("exportLook"); return current; },
    begin: opts => { log("begin", opts); if (beginResult) active = true; return beginResult; },
    cancel: () => { log("cancel"); active = false; return true; },
    importLook: look => { log("importLook", look); if (importThrows) throw new Error("boom"); current = look; return true; },
    isActive: () => active,
    applyPatch: patch => { log("applyPatch", patch); if (patch.preset) appliedPreset = patch.preset; return 1; },
    getSchema: () => (polls++ < schemaReadyAfterPolls ? null : { gender: schemaGender, categories: { hairStyle: { options: ["a", "b"], count: 2 } } }),
    getState: () => ({ gender: schemaGender, selections: appliedPreset ? { preset: appliedPreset } : {} }),
    setVoice: voice => { log("setVoice", voice); return true; },
    previewVoice: () => { log("previewVoice"); return true; },
    getCapabilities: () => ({ version: 9 }),
  };
  const sandbox = {
    console,
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ id, fn, at: now + ms }); return id; },
    clearTimeout: id => { timers = timers.filter(timer => timer.id !== id); },
    Events: {
      on: (name, fn) => { handlers[name] = fn; },
      emitServer: (name, payload) => log("emitServer", name, payload),
    },
    Web: {
      createView: () => 1,
      destroyView: () => log("destroyView"),
      on: (_view, name, fn) => { viewHandlers[name] = fn; },
      emit: (_view, name, payload) => log("emit", name, payload),
      getScreenSize: () => ({ width: screenWidth, height: 1080 }),
    },
    Game: { setPauseMenuEnabled() {}, setActionScreenEnabled() {}, setToolWheelEnabled() {}, notify() {} },
    LocalPlayer: { stopPlayerInput() {}, restorePlayerInput() {}, getPosition: () => ({ x: 1, y: 2, z: 3 }) },
    World: { lineTrace: () => { log("lineTrace"); if (groundThrows) throw new Error("no trace"); return groundPolls++ < groundAfterPolls ? null : { startPenetrating: false }; } },
    Creator,
    CreatorPreview: {
      setCamera: frame => log("setCamera", frame),
      restoreCamera: () => log("restoreCamera"),
      freeze: frozen => log("freeze", frozen),
    },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "client/main.js" });
  const advance = ms => {
    now += ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      timers = timers.filter(timer => timer !== due);
      due.fn();
    }
  };
  const names = () => calls.map(call => call[0]);
  return {
    calls, handlers, viewHandlers, advance, names,
    account, setCurrent: look => { current = look; }, setGender: gender => { schemaGender = gender; },
    state: state => handlers["ms-character:state"](state),
    ready: () => viewHandlers.ready(),
    clear: () => { calls.length = 0; },
    isActive: () => active,
    get timerCount() { return timers.length; },
  };
}

const LOBBY = { status: "lobby", characters: [
  { characterId: "1", firstName: "A", lastName: "B", house: "Gryffindor", look: { presets: { hairStyle: "one" } } },
  { characterId: "2", firstName: "C", lastName: "D", house: "Slytherin", look: null },
] };

// The lobby session opens once the world around the spawn has loaded: the first ground check runs 250 ms after the state.
function openLobby(h) { h.state(LOBBY); h.ready(); h.advance(250); }

test("lobby ready opens one session, saves originalLook and frames the body", () => {
  const h = harness();
  openLobby(h);
  same(h.names().filter(n => ["exportLook", "begin", "setCamera"].includes(n)), ["exportLook", "begin", "setCamera"]);
  same(h.calls.find(c => c[0] === "begin")[1], { preserveCurrent: true });
  h.state(LOBBY); // repeated state never opens a second session
  assert.equal(h.names().filter(n => n === "begin").length, 1);
});

test("camera:frame uses client presets with proportional shift", () => {
  const h = harness({ screenWidth: 1280 });
  openLobby(h);
  h.clear();
  h.viewHandlers["camera:frame"]({ framing: "face", shift: 9999 });
  same(h.calls[0], ["setCamera", { dist: 130, height: 65, pitch: 0, shift: 15 * (1280 / 1920) }]);
  h.viewHandlers["camera:frame"]({ framing: "body" });
  same(h.calls[1][1], { dist: 720, height: -25, pitch: 2, shift: 80 * (1280 / 1920), fov: 28 });
  h.clear();
  h.viewHandlers["camera:frame"]({ framing: "bogus" });
  assert.equal(h.calls.length, 0);
});

test("lobby:preview imports the saved look, null or look:null shows originalLook", () => {
  const h = harness();
  openLobby(h);
  h.clear();
  h.viewHandlers["lobby:preview"]({ characterId: "1" });
  same(h.calls, [["importLook", LOBBY.characters[0].look]]);
  h.clear();
  h.viewHandlers["lobby:preview"]({ characterId: "2" });
  same(h.calls, [["importLook", h.account]]);
  h.clear();
  h.viewHandlers["lobby:preview"](null);
  same(h.calls, [["importLook", h.account]]);
});

test("creator:begin from the lobby restores originalLook first, then sends the schema once ready", () => {
  const h = harness({ schemaReadyAfterPolls: 2 });
  openLobby(h);
  h.viewHandlers["lobby:preview"]({ characterId: "1" });
  h.clear();
  h.viewHandlers["creator:begin"]();
  assert.equal(h.calls[0][0], "importLook");
  assert.equal(h.calls[0][1], h.account);
  assert.equal(h.names().includes("begin"), false, "shared session: no second begin");
  assert.equal(h.names().includes("emit"), false, "schema is null: nothing sent yet");
  h.advance(50); h.advance(50);
  const schema = h.calls.find(c => c[0] === "emit" && c[1] === "creator:schema");
  assert.ok(schema);
  same(schema[2].categories, [{ id: "hairStyle", options: ["a", "b"] }]);
  assert.ok(schema[2].capabilities && schema[2].state);
});

test("creator:begin failure sends creator:error and leaves no camera or session", () => {
  const h = harness({ beginResult: false });
  h.state({ status: "lobby", characters: [] });
  h.ready();
  h.clear();
  h.viewHandlers["creator:begin"]();
  same(h.calls.find(c => c[0] === "emit")[1], "creator:error");
  assert.equal(h.names().includes("setCamera"), false);
  assert.equal(h.names().includes("cancel"), false);
});

test("previews are debounced to the last one, commit applies at once and sends state", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.clear();
  for (const id of ["a", "b", "c"]) h.viewHandlers["creator:patch"]({ category: "hairStyle", id, commit: false });
  h.advance(79);
  assert.equal(h.names().includes("applyPatch"), false);
  h.advance(1);
  same(h.calls.filter(c => c[0] === "applyPatch"), [["applyPatch", { hairStyle: "c" }]]);
  h.clear();
  h.viewHandlers["creator:patch"]({ category: "skin", id: "x", commit: true });
  same(h.names(), ["applyPatch"]); // the state is read only after the game applied the patch
  h.handlers.creatorChanged({ change: { category: "skin", id: "x", ok: true } });
  same(h.calls.filter(c => c[0] === "emit").map(c => c[1]), ["creator:state", "creator:state"]); // echo + commit reply
});

test("a commit is answered after 150 ms when no creatorChanged arrives", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.clear();
  h.viewHandlers["creator:patch"]({ category: "skin", id: "x", commit: true });
  h.advance(149);
  assert.equal(h.names().includes("emit"), false);
  h.advance(1);
  same(h.calls.filter(c => c[0] === "emit").map(c => c[1]), ["creator:state"]);
});

test("creator:body patches preset and resends the schema on the matching creatorChanged", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.clear();
  h.viewHandlers["creator:body"]({ preset: "BodyFemale001" });
  same(h.calls[0], ["applyPatch", { preset: "BodyFemale001" }]);
  h.setGender(1);
  h.handlers.creatorChanged({ change: { category: "preset", id: "BodyFemale001", ok: true } });
  assert.equal(h.calls.filter(c => c[0] === "emit" && c[1] === "creator:schema").length, 1);
  h.advance(1000); // fallback must not send a duplicate
  assert.equal(h.calls.filter(c => c[0] === "emit" && c[1] === "creator:schema").length, 1);
});

test("creator:body resends the schema after the fallback when no creatorChanged arrives", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.clear();
  h.viewHandlers["creator:body"]({ preset: "BodyMale002" });
  h.advance(250);
  assert.equal(h.calls.filter(c => c[0] === "emit" && c[1] === "creator:schema").length, 1);
});

test("voice changes are debounced, validated, flushed before the preview and kept for the created look", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.clear();
  for (const voice of [{ tone: 2, pitch: 0 }, { tone: 0.5, pitch: 0 }, { tone: 0, pitch: 11 }, { tone: 0, pitch: "1" }, null, "x"]) h.viewHandlers["creator:voice"](voice);
  h.advance(500);
  assert.equal(h.names().includes("setVoice"), false, "invalid voices are ignored");
  h.viewHandlers["creator:voice"]({ tone: 0, pitch: 1 });
  h.viewHandlers["creator:voice"]({ tone: 1, pitch: 4 });
  h.advance(79);
  assert.equal(h.names().includes("setVoice"), false);
  h.advance(1);
  same(h.calls.filter(c => c[0] === "setVoice"), [["setVoice", { tone: 1, pitch: 4 }]]);
  h.clear();
  h.viewHandlers["creator:voice"]({ tone: 0, pitch: -3 });
  h.viewHandlers["creator:voice:preview"]();
  same(h.names(), ["setVoice"]);
  h.advance(119);
  assert.equal(h.names().includes("previewVoice"), false, "plays only after the game applied the voice");
  h.advance(1);
  same(h.names(), ["setVoice", "previewVoice"]);
  h.viewHandlers.create({ firstName: "Ana", lastName: "Silva", house: "Ravenclaw" });
  same(h.calls.find(c => c[0] === "emitServer")[2].look.voice, { tone: 0, pitch: -3 });
});

test("create sends the exported look with the pronoun kept across a body change, then releases", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.viewHandlers["creator:pronoun"]({ pronoun: "witch" });
  h.viewHandlers["creator:body"]({ preset: "BodyFemale001" });
  h.clear();
  h.viewHandlers.create({ firstName: "Ana", lastName: "Silva", house: "Ravenclaw", extra: 1 });
  const sent = h.calls.find(c => c[0] === "emitServer");
  assert.ok(h.names().indexOf("emitServer") < h.names().indexOf("importLook"), "emitted before the session is released");
  assert.equal(sent[1], "ms-character:create");
  same(Object.keys(sent[2]).sort(), ["firstName", "house", "lastName", "look"]);
  assert.equal(sent[2].look.pronoun, "witch");
  assert.equal(h.account.pronoun, "wizard", "exported object is not mutated");
  const rest = h.names();
  same(rest.filter(n => ["importLook", "cancel", "freeze", "restoreCamera"].includes(n)), ["importLook", "cancel", "freeze", "restoreCamera"]);
  assert.equal(h.isActive(), false);
});

test("creator:cancel back to the lobby keeps the session and camera: restores the look and the body frame only", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.clear();
  h.viewHandlers["creator:cancel"]();
  const names = h.names();
  assert.ok(names.includes("importLook"));
  for (const forbidden of ["cancel", "freeze", "restoreCamera", "begin"]) assert.ok(!names.includes(forbidden), forbidden + " must not run");
  assert.ok(names.includes("setCamera"));
  assert.equal(h.timerCount, 0);
});

test("select restores look, cancels and restores camera before emitting to the server", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["lobby:preview"]({ characterId: "1" });
  h.clear();
  h.viewHandlers.select({ characterId: "1" });
  same(h.names(), ["importLook", "cancel", "freeze", "restoreCamera", "emitServer"]);
  assert.equal(h.calls[0][1], h.account);
});

test("playing and resourceStop clean up idempotently, only what was acquired", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.viewHandlers["creator:patch"]({ category: "hairStyle", id: "z", commit: false });
  h.clear();
  h.state({ status: "playing", characters: [] });
  same(h.names().filter(n => n !== "destroyView"), ["importLook", "cancel", "freeze", "restoreCamera"]);
  assert.equal(h.timerCount, 0);
  h.clear();
  h.handlers.resourceStop("ms-character");
  assert.equal(h.names().some(n => ["importLook", "cancel", "freeze", "restoreCamera"].includes(n)), false, "second cleanup is a no-op");

  const g = harness({ beginResult: false });
  g.state({ status: "lobby", characters: [] }); g.ready(); g.clear();
  g.handlers.resourceStop("ms-character");
  assert.equal(g.names().some(n => ["importLook", "cancel", "freeze", "restoreCamera"].includes(n)), false, "never acquired: nothing touched");
});

test("resourceStop mid-creator releases the session and the camera", () => {
  const h = harness();
  openLobby(h);
  h.viewHandlers["creator:begin"]();
  h.clear();
  h.handlers.resourceStop("ms-character");
  same(h.names().filter(n => ["importLook", "cancel", "freeze", "restoreCamera"].includes(n)), ["importLook", "cancel", "freeze", "restoreCamera"]);
});

test("cleanup still completes when importLook throws", () => {
  const h = harness({ importThrows: true });
  openLobby(h);
  h.clear();
  h.state({ status: "playing", characters: [] });
  same(h.names().filter(n => n === "cancel" || n === "restoreCamera"), ["cancel", "restoreCamera"]);
  assert.equal(h.isActive(), false);
});

const worldFlags = h => h.calls.filter(c => c[0] === "emit" && c[1] === "state").map(c => c[2].worldLoaded);

test("world gate: the page gets worldLoaded=false and no lobby session opens until the ground under the player loads", () => {
  const h = harness({ groundAfterPolls: 2 });
  h.state({ status: "loading" }); h.ready(); h.state(LOBBY);
  assert.equal(worldFlags(h).every(flag => flag === false), true);
  h.advance(250); h.advance(250); // two checks miss
  assert.equal(h.names().includes("begin"), false, "no preview model while the world loads");
  assert.equal(worldFlags(h).every(flag => flag === false), true);
  h.advance(250); // third check hits
  assert.equal(worldFlags(h).at(-1), true);
  assert.equal(h.names().filter(n => n === "begin").length, 1);
  h.advance(5000); assert.equal(h.names().filter(n => n === "lineTrace").length, 3, "polling stops once loaded");
});

test("world gate: the ceiling and a failing check never block the player", () => {
  const slow = harness({ groundAfterPolls: 1e9 });
  slow.state(LOBBY); slow.ready(); slow.advance(4000);
  assert.equal(worldFlags(slow).at(-1), false);
  slow.advance(1500);
  assert.equal(worldFlags(slow).at(-1), true);
  assert.equal(slow.names().filter(n => n === "begin").length, 1);
  const broken = harness({ groundThrows: true });
  broken.state(LOBBY); broken.ready(); broken.advance(250);
  assert.equal(worldFlags(broken).at(-1), true);
});

test("world gate: a new lobby (status loading) waits for its world again, other states keep it open", () => {
  const h = harness();
  openLobby(h);
  h.state({ ...LOBBY, status: "creating" }); h.state(LOBBY);
  assert.equal(worldFlags(h).at(-1), true);
  h.state({ status: "playing" }); h.state({ status: "loading" }); h.ready();
  assert.equal(worldFlags(h).at(-1), false);
});

test("world gate: groundSnapped from the server opens the lobby at once, and the loading state never polls", () => {
  const h = harness({ groundAfterPolls: 1e9 });
  h.state({ status: "loading", characters: [], maxCharacters: 1, groundSnapped: false }); h.ready();
  h.advance(20000);
  assert.equal(h.names().includes("lineTrace"), false, "no ground check while the server still waits");
  assert.equal(worldFlags(h).every(flag => flag === false), true);
  h.state({ ...LOBBY, groundSnapped: true });
  assert.equal(worldFlags(h).at(-1), true);
  assert.equal(h.names().filter(n => n === "begin").length, 1);
  assert.equal(h.names().includes("lineTrace"), false, "the game's own ground wait replaces the trace");
});
