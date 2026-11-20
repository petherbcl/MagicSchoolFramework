"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, slugify } = require("../server/config");

const load = (locations, extra = {}) => loadConfig({ ...(locations === undefined ? {} : { MS_SPAWN_LOCATIONS: typeof locations === "string" ? locations : JSON.stringify(locations) }), ...extra }, { envFile: null });
const entry = (name, extra = {}) => ({ name, x: 1, y: 2, z: 3, yaw: 4, ...extra });
const code = expected => ({ name: "SpawnConfigError", code: expected });

test("a valid list returns a frozen config with derived ids", () => {
  const config = load([entry("Sala Comum Slytherin"), entry("Hogsmeade", { x: -5.5 })]);
  assert.deepEqual(config.locations.map(item => item.id), ["sala-comum-slytherin", "hogsmeade"]);
  assert.deepEqual({ ...config.locations[1] }, { id: "hogsmeade", name: "Hogsmeade", x: -5.5, y: 2, z: 3, yaw: 4 });
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.locations) && Object.isFrozen(config.locations[0]) && Object.isFrozen(config.camera));
});
test("ids are slugs of the name and stable across loads", () => {
  assert.equal(slugify("Sala Comum Slytherin"), "sala-comum-slytherin");
  assert.equal(slugify("Pátio de Hogwarts"), "patio-de-hogwarts");
  assert.equal(slugify("  Hogsmeade!! "), "hogsmeade");
  const list = [entry("Pátio de Hogwarts"), entry("Hogsmeade")];
  assert.deepEqual(load(list).locations.map(item => item.id), load(list).locations.map(item => item.id));
});
test("zero entries (and an unset variable) are valid", () => {
  assert.deepEqual([...load([]).locations], []);
  assert.deepEqual([...load(undefined).locations], []);
});
test("the .env.example defaults are valid with 6 unique locations, copied exactly", () => {
  const file = path.join(__dirname, "..", ".env.example");
  const config = loadConfig({}, { envFile: file });
  assert.deepEqual(config.locations.map(item => item.name), ["Sala Comum Slytherin", "Sala Comum Hufflepuff", "Sala Comum Gryffindor", "Sala Comum Ravenclaw", "Pátio de Hogwarts", "Hogsmeade"]);
  assert.equal(new Set(config.locations.map(item => item.id)).size, 6);
  assert.deepEqual({ ...config.locations[0] }, { id: "sala-comum-slytherin", name: "Sala Comum Slytherin", x: 359573, y: -451727.25, z: -85308.25, yaw: -146.48 });
  assert.deepEqual({ ...config.locations[5] }, { id: "hogsmeade", name: "Hogsmeade", x: 395037.5, y: -519061, z: -82090.25, yaw: 112.24 });
  assert.equal(config.camera.durationMs, 1500);
});
test("invalid configurations fail closed with a stable code", () => {
  assert.throws(() => load("[{"), code("LOCATIONS_INVALID_JSON"));
  assert.throws(() => load({ name: "x" }), code("LOCATIONS_NOT_ARRAY"));
  assert.throws(() => load(Array.from({ length: 13 }, (_, index) => entry("Local " + index))), code("LOCATIONS_TOO_MANY"));
  assert.equal(load(Array.from({ length: 12 }, (_, index) => entry("Local " + index))).locations.length, 12);
  assert.throws(() => load([entry("Hogsmeade"), entry("HOGSMEADE")]), code("LOCATION_NAME_DUPLICATE"));
  assert.throws(() => load([entry("Hogsmeade"), entry("Hogsmeade!")]), { code: "LOCATION_ID_COLLISION" });
  assert.throws(() => load([entry("Pátio"), entry("Patio")]), { code: "LOCATION_ID_COLLISION" });
  assert.throws(() => load([entry("???")]), code("LOCATION_ID_EMPTY"));
  assert.throws(() => load([entry("Last")]), code("LOCATION_ID_RESERVED"));
  assert.throws(() => load([entry("  ")]), code("LOCATION_NAME_INVALID"));
  assert.throws(() => load([entry("")]), code("LOCATION_NAME_INVALID"));
  assert.throws(() => load([entry("x".repeat(41))]), code("LOCATION_NAME_INVALID"));
  assert.equal(load([entry("x".repeat(40))]).locations.length, 1);
  assert.throws(() => load([entry("Mau\u0007nome")]), code("LOCATION_NAME_INVALID"));
  assert.throws(() => load([entry("Mau\nnome")]), code("LOCATION_NAME_INVALID"));
  assert.throws(() => load([entry(5)]), code("LOCATION_NAME_INVALID"));
  assert.throws(() => load([entry("A", { x: "1" })]), code("LOCATION_NUMBER_INVALID"));
  assert.throws(() => load([entry("A", { y: null })]), code("LOCATION_NUMBER_INVALID"));
  assert.throws(() => load([entry("A", { z: 1e9 })]), code("LOCATION_NUMBER_INVALID"));
  assert.throws(() => load('[{"name":"A","x":1e999,"y":0,"z":0,"yaw":0}]'), code("LOCATION_NUMBER_INVALID"));
  assert.throws(() => load([{ name: "A", x: 1, y: 2, z: 3 }]), code("LOCATION_NUMBER_INVALID"));
  assert.throws(() => load([entry("A", { extra: 1 })]), code("LOCATION_INVALID_ENTRY"));
  assert.throws(() => load([null]), code("LOCATION_INVALID_ENTRY"));
  assert.throws(() => load([[1]]), code("LOCATION_INVALID_ENTRY"));
});
test("error messages never carry configuration values", () => {
  try { load([entry("Segredo", { x: "nao" })]); assert.fail("expected an error"); }
  catch (error) { assert.doesNotMatch(error.message, /Segredo|nao/); }
});
test("camera variables have defaults, limits and stable codes", () => {
  const config = load([]);
  assert.deepEqual({ ...config.camera }, { durationMs: 1500, easing: "easeInOut", distance: 1200, height: 600, departureHeight: 1500, departureDistance: 3000 });
  assert.equal(config.areaTimeoutMs, 15000);
  const custom = load([], { MS_SPAWN_CAMERA_DURATION_MS: "2000", MS_SPAWN_CAMERA_EASING: "easeOut", MS_SPAWN_CAMERA_DISTANCE: "900", MS_SPAWN_CAMERA_HEIGHT: "0", MS_SPAWN_CAMERA_DEPARTURE_HEIGHT: "2500", MS_SPAWN_CAMERA_DEPARTURE_DISTANCE: "0", MS_SPAWN_AREA_TIMEOUT_MS: "3000" });
  assert.deepEqual({ ...custom.camera }, { durationMs: 2000, easing: "easeOut", distance: 900, height: 0, departureHeight: 2500, departureDistance: 0 });
  assert.equal(custom.areaTimeoutMs, 3000);
  for (const bad of [{ MS_SPAWN_CAMERA_DURATION_MS: "10" }, { MS_SPAWN_CAMERA_DURATION_MS: "abc" }, { MS_SPAWN_CAMERA_EASING: "bounce" }, { MS_SPAWN_CAMERA_DISTANCE: "0" },
    { MS_SPAWN_CAMERA_HEIGHT: "-1" }, { MS_SPAWN_CAMERA_DEPARTURE_HEIGHT: "-1" }, { MS_SPAWN_CAMERA_DEPARTURE_HEIGHT: "20001" }, { MS_SPAWN_CAMERA_DEPARTURE_DISTANCE: "-5" }, { MS_SPAWN_CAMERA_DEPARTURE_DISTANCE: "abc" }, { MS_SPAWN_AREA_TIMEOUT_MS: "999" }, { MS_SPAWN_AREA_TIMEOUT_MS: "NaN" }]) {
    assert.throws(() => load([], bad), code(bad.MS_SPAWN_CAMERA_EASING ? "CAMERA_CONFIG_INVALID" : "CAMERA_CONFIG_INVALID"), JSON.stringify(bad));
  }
});
test("process env overrides the .env file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ms-spawn-"));
  const file = path.join(directory, ".env");
  try {
    fs.writeFileSync(file, `MS_SPAWN_LOCATIONS='[{"name":"Do ficheiro","x":1,"y":2,"z":3,"yaw":4}]'\nMS_SPAWN_AREA_TIMEOUT_MS=2000\n`);
    assert.deepEqual(loadConfig({}, { envFile: file }).locations.map(item => item.id), ["do-ficheiro"]);
    const merged = loadConfig({ MS_SPAWN_LOCATIONS: JSON.stringify([entry("Do processo")]) }, { envFile: file });
    assert.deepEqual(merged.locations.map(item => item.id), ["do-processo"]);
    assert.equal(merged.areaTimeoutMs, 2000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("a missing .env file is fine, an unreadable one fails closed", () => {
  assert.equal(loadConfig({}, { envFile: path.join(os.tmpdir(), "does-not-exist-ms-spawn.env") }).locations.length, 0);
  assert.throws(() => loadConfig({}, { envFile: os.tmpdir() }), code("ENV_FILE_UNREADABLE"));
});

test("SEC-05: location names with format characters (bidi override, zero width) are rejected", () => {
  for (const bad of ["Mau‮nome", "Zero​width", "Bom⁦dia", "a‍"]) assert.throws(() => load([entry(bad)]), code("LOCATION_NAME_INVALID"));
  assert.doesNotThrow(() => load([entry("Pátio de Hogwarts")]));
});
test("SEC-03: MS_SPAWN_OPEN_ACK_TIMEOUT_MS defaults to 30000 and is bounded 5000 to 600000", () => {
  assert.equal(load([]).openAckTimeoutMs, 30000);
  assert.equal(load([], { MS_SPAWN_OPEN_ACK_TIMEOUT_MS: "60000" }).openAckTimeoutMs, 60000);
  for (const value of ["4999", "600001", "NaN", "-1"]) assert.throws(() => load([], { MS_SPAWN_OPEN_ACK_TIMEOUT_MS: value }), code("CAMERA_CONFIG_INVALID"));
});

test("CHG-03: preview snap defaults to false and timing log to true; both parse strict booleans and fail closed", () => {
  const base = load([]);
  assert.equal(base.previewSnapToGround, false); assert.equal(base.timingLog, true);
  for (const [raw, expected] of [["true", true], ["TRUE", true], ["1", true], ["false", false], ["False", false], ["0", false], ["", null], ["  ", null]]) {
    const config = load([], { MS_SPAWN_PREVIEW_SNAP_TO_GROUND: raw, MS_SPAWN_TIMING_LOG: raw });
    assert.equal(config.previewSnapToGround, expected ?? false, raw); assert.equal(config.timingLog, expected ?? true, raw);
  }
  for (const key of ["MS_SPAWN_PREVIEW_SNAP_TO_GROUND", "MS_SPAWN_TIMING_LOG"]) {
    for (const bad of ["yes", "on", "2", "maybe", "truee"]) {
      assert.throws(() => load([], { [key]: bad }), { name: "SpawnConfigError", code: "BOOLEAN_CONFIG_INVALID" }, key + "=" + bad);
    }
  }
});
