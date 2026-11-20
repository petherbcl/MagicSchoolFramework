"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, slugify } = require("../server/config");

const load = (locations, extra = {}) => loadConfig({ ...(locations === undefined ? {} : { MS_SPAWN_LOCATIONS: typeof locations === "string" ? locations : JSON.stringify(locations) }), ...extra }, { envFile: null });
const CAMERA = { x: 10, y: 20, z: 30 };
const entry = (name, extra = {}) => ({ name, x: 1, y: 2, z: 3, yaw: 4, camera: CAMERA, ...extra });
const code = expected => ({ name: "SpawnConfigError", code: expected });

test("a valid list returns a frozen config with derived ids", () => {
  const config = load([entry("Sala Comum Slytherin"), entry("Hogsmeade", { x: -5.5 })]);
  assert.deepEqual(config.locations.map(item => item.id), ["sala-comum-slytherin", "hogsmeade"]);
  assert.deepEqual({ ...config.locations[1] }, { id: "hogsmeade", name: "Hogsmeade", x: -5.5, y: 2, z: 3, yaw: 4, camera: config.locations[1].camera });
  assert.deepEqual({ ...config.locations[1].camera, lookAt: { ...config.locations[1].camera.lookAt } }, { x: 10, y: 20, z: 30, lookAt: { x: -5.5, y: 2, z: 3 } });
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.locations) && Object.isFrozen(config.locations[0]) && Object.isFrozen(config.camera));
  assert.ok(Object.isFrozen(config.locations[0].camera) && Object.isFrozen(config.locations[0].camera.lookAt));
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
test("the .env.example defaults are valid with 6 unique locations, spawn points unchanged and a camera in each", () => {
  const file = path.join(__dirname, "..", ".env.example");
  const config = loadConfig({}, { envFile: file });
  assert.deepEqual(config.locations.map(item => item.name), ["Sala Comum Slytherin", "Sala Comum Hufflepuff", "Sala Comum Gryffindor", "Sala Comum Ravenclaw", "Pátio de Hogwarts", "Hogsmeade"]);
  assert.equal(new Set(config.locations.map(item => item.id)).size, 6);
  const spawnPoint = ({ x, y, z, yaw }) => ({ x, y, z, yaw });
  assert.deepEqual(config.locations.map(spawnPoint), [
    { x: 359573, y: -451727.25, z: -85308.25, yaw: -146.48 }, { x: 362522.25, y: -445054.25, z: -83609.5, yaw: -107.16 },
    { x: 353218.75, y: -450775, z: -79306.5, yaw: 10.53 }, { x: 357398.75, y: -455215.5, z: -77308, yaw: -80.18 },
    { x: 368521.5, y: -458878.75, z: -82609.5, yaw: -16.3 }, { x: 395037.5, y: -519061, z: -82090.25, yaw: 112.24 }]);
  assert.deepEqual(config.locations.map(item => item.role), ["slytherin", "hufflepuff", "gryffindor", "ravenclaw", undefined, undefined]);
  assert.deepEqual(config.locations.map(item => item.icon), ["slytherin.png", "hufflepuff.png", "gryffindor.png", "ravenclaw.png", undefined, undefined]);
  assert.equal(config.locations[0].id, "sala-comum-slytherin");
  // Every default has a camera position; the aiming is lookAt (default mode resolves it to the spawn point) or yaw mode (CHG-06).
  assert.ok(config.locations.every(item => item.camera && [item.camera.x, item.camera.y, item.camera.z].every(Number.isFinite)
    && (item.camera.lookAt ? Number.isFinite(item.camera.lookAt.x) : Number.isFinite(item.camera.yaw))));
  assert.equal(config.camera.durationMs, 1500);
  // The cameras of .env.example are tuned by the user (any aiming mode), so only their validity is asserted, not a derivation.
});
test("every icon file named in the .env.example exists in ui-src/public/icons", () => {
  const config = loadConfig({}, { envFile: path.join(__dirname, "..", ".env.example") });
  for (const item of config.locations) if (item.icon) assert.ok(fs.existsSync(path.join(__dirname, "..", "ui-src", "public", "icons", item.icon)), item.icon);
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
  assert.throws(() => load([{ name: "A", x: 1, y: 2, z: 3, camera: CAMERA }]), code("LOCATION_NUMBER_INVALID"));
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
    fs.writeFileSync(file, `MS_SPAWN_LOCATIONS='[{"name":"Do ficheiro","x":1,"y":2,"z":3,"yaw":4,"camera":{"x":9,"y":9,"z":9}}]'\nMS_SPAWN_AREA_TIMEOUT_MS=2000\n`);
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

// CHG-04 (STORY-01.06): optional role per location.
const roleEntry = (name, role) => ({ name, x: 1, y: 2, z: 3, yaw: 4, camera: CAMERA, ...(role === undefined ? {} : { role }) });
test("01.06: a valid role is stored without changing id, name or coordinates", () => {
  const [a] = load([roleEntry("Sala Comum Gryffindor", "gryffindor")]).locations;
  assert.deepEqual({ ...a }, { id: "sala-comum-gryffindor", name: "Sala Comum Gryffindor", x: 1, y: 2, z: 3, yaw: 4, role: "gryffindor", camera: a.camera });
  assert.ok(Object.isFrozen(a));
  for (const role of ["a", "x".repeat(32), "my_role-2"]) assert.equal(load([roleEntry("L", role)]).locations[0].role, role);
});
test("01.06: a missing or empty role means open to everyone", () => {
  for (const role of [undefined, ""]) assert.equal("role" in load([roleEntry("L", role)]).locations[0], false);
});
test("01.06: a malformed role fails closed with a stable code", () => {
  for (const role of ["Gryffindor", "x".repeat(33), "a b", "a.b", "é", " gryffindor", 5, null, true, ["a"], {}]) {
    assert.throws(() => load([roleEntry("L", role)]), { name: "SpawnConfigError", code: "LOCATION_ROLE_INVALID" }, JSON.stringify(role));
  }
});
test("01.06: the role is not part of the slug or the uniqueness checks", () => {
  assert.throws(() => load([roleEntry("Hogsmeade", "gryffindor"), roleEntry("Hogsmeade")]), { code: "LOCATION_NAME_DUPLICATE" });
  assert.throws(() => load([roleEntry("Sala A", "x"), roleEntry("sala-a", "y")]), { code: "LOCATION_ID_COLLISION" });
  assert.equal(load([roleEntry("A", "same"), roleEntry("B", "same")]).locations.length, 2);
});
test("01.06: a well formed role that no character has is accepted", () => {
  assert.equal(load([roleEntry("L", "nobody-has-this")]).locations[0].role, "nobody-has-this");
});

// CHG-05 (STORY-01.07): mandatory camera with optional lookAt.
const camErr = { name: "SpawnConfigError", code: "LOCATION_CAMERA_INVALID" };
const withCamera = camera => ({ name: "Cam", x: 1, y: 2, z: 3, yaw: 4, ...(camera === undefined ? {} : { camera }) });
test("01.07: a valid camera is stored without changing id, name, role or the spawn point; lookAt defaults to the spawn point", () => {
  const [a] = load([entry("Sala A", { role: "r1" })]).locations;
  assert.deepEqual({ ...a, camera: { ...a.camera, lookAt: { ...a.camera.lookAt } } }, { id: "sala-a", name: "Sala A", x: 1, y: 2, z: 3, yaw: 4, role: "r1", camera: { x: 10, y: 20, z: 30, lookAt: { x: 1, y: 2, z: 3 } } });
});
test("01.07: an explicit lookAt is kept and the result is frozen in depth", () => {
  const [a] = load([entry("A", { camera: { x: 10, y: 20, z: 30, lookAt: { x: 7, y: 8, z: 9 } } })]).locations;
  assert.deepEqual({ ...a.camera.lookAt }, { x: 7, y: 8, z: 9 });
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.camera) && Object.isFrozen(a.camera.lookAt));
  // The spawn point written out as lookAt is allowed (it is not the camera).
  assert.equal(load([entry("A", { camera: { x: 10, y: 20, z: 30, lookAt: { x: 1, y: 2, z: 3 } } })]).locations.length, 1);
});
test("01.07: a missing or malformed camera fails closed with LOCATION_CAMERA_INVALID", () => {
  const bad = [undefined, null, "x", [1, 2, 3], 5, {}, { x: 1, y: 2 }, { x: 1, z: 3 }, { y: 2, z: 3 }, { x: NaN, y: 2, z: 3 }, { x: "1", y: 2, z: 3 }, { x: 1, y: null, z: 3 },
    { x: 1e8, y: 2, z: 3 }, { x: 1, y: 2, z: -1e8 }, { x: 1, y: 2, z: 3, extra: 1 },
    { x: 1, y: 2, z: 3, lookAt: null }, { x: 1, y: 2, z: 3, lookAt: "a" }, { x: 1, y: 2, z: 3, lookAt: [1, 2, 3] }, { x: 1, y: 2, z: 3, lookAt: { x: 1, y: 2 } },
    { x: 1, y: 2, z: 3, lookAt: { x: 1, y: 2, z: "3" } }, { x: 1, y: 2, z: 3, lookAt: { x: 1e9, y: 2, z: 3 } }, { x: 1, y: 2, z: 3, lookAt: { x: 5, y: 5, z: 5, w: 1 } }];
  for (const camera of bad) assert.throws(() => load([withCamera(camera)]), camErr, JSON.stringify(camera));
  assert.throws(() => load('[{"name":"A","x":1,"y":2,"z":3,"yaw":4,"camera":{"x":1e999,"y":2,"z":3}}]'), camErr);
});
test("01.07: a camera without direction is invalid (G21): equal to its lookAt, or without lookAt equal to the spawn point", () => {
  assert.throws(() => load([withCamera({ x: 1, y: 2, z: 3 })]), camErr);
  assert.throws(() => load([withCamera({ x: 5, y: 6, z: 7, lookAt: { x: 5, y: 6, z: 7 } })]), camErr);
  assert.equal(load([withCamera({ x: 1, y: 2, z: 3, lookAt: { x: 5, y: 6, z: 7 } })]).locations.length, 1); // a camera at the spawn point is fine with another lookAt
});
test("01.07: the camera error names the location and the field, never a value", () => {
  try { load([withCamera({ x: 1, y: 2, z: "secreto-123", lookAt: { x: 4, y: 5, z: 6 } })]); assert.fail("expected an error"); }
  catch (error) { assert.equal(error.code, "LOCATION_CAMERA_INVALID"); assert.match(error.message, /Cam/); assert.match(error.message, /camera\.z/); assert.doesNotMatch(error.message, /secreto|123/); }
  try { load([withCamera({ x: 1, y: 2, z: 3, lookAt: { x: 4, y: 5, z: NaN } })]); assert.fail("expected an error"); }
  catch (error) { assert.match(error.message, /camera\.lookAt\.z/); }
});
test("01.07: the old format (no camera) is refused, zero entries stay valid", () => {
  assert.throws(() => load('[{"name":"Hogsmeade","x":1,"y":2,"z":3,"yaw":4}]'), camErr);
  assert.deepEqual([...load("[]").locations], []);
});
test("01.07: the camera takes no part in the slug or the uniqueness checks", () => {
  assert.equal(load([entry("A", { camera: { x: 5, y: 5, z: 5 } }), entry("B", { camera: { x: 5, y: 5, z: 5 } })]).locations.length, 2);
});

// CHG-05 (STORY-01.08): optional icon file name.
test("01.08: a valid icon is stored; missing, empty and null mean no icon", () => {
  for (const icon of ["a.png", "slytherin.png", "hogs_meade-2.webp", "x.jpg", "x.jpeg", "x.svg", "a".repeat(60) + ".png"]) assert.equal(load([entry("L", { icon })]).locations[0].icon, icon, icon);
  for (const icon of [undefined, "", null]) assert.equal("icon" in load([entry("L", { icon })]).locations[0], false, String(icon));
});
test("01.08: a malformed icon fails closed with LOCATION_ICON_INVALID", () => {
  const bad = ["a.gif", "a.PNG", "A.png", "a", ".png", "a.png.exe", "a b.png", "../a.png", "dir/a.png", "dir\\a.png", "a.png ", " a.png", "é.png", "a.png\n", "a".repeat(61) + ".png", "http://x/a.png", "a.svg?x=1", 5, true, ["a.png"], {}];
  for (const icon of bad) assert.throws(() => load([entry("L", { icon })]), { name: "SpawnConfigError", code: "LOCATION_ICON_INVALID" }, JSON.stringify(icon));
});
test("01.08: the icon is not part of the slug, the role or the uniqueness checks", () => {
  assert.throws(() => load([entry("Hogsmeade", { icon: "a.png" }), entry("Hogsmeade")]), { code: "LOCATION_NAME_DUPLICATE" });
  assert.equal(load([entry("A", { icon: "same.png" }), entry("B", { icon: "same.png" })]).locations.length, 2);
  assert.equal(load([entry("A", { icon: "a.png", role: "x" })]).locations[0].id, "a");
});

// CHG-05 (STORY-06.13): the README examples are valid config and use only coordinates of the six default locations.
test("06.13: the JSON examples in the README load through the real config and use only known coordinates", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const blocks = [...readme.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
  assert.ok(blocks.length >= 2);
  const known = loadConfig({}, { envFile: path.join(__dirname, "..", ".env.example") }).locations;
  for (const block of blocks) {
    const config = load(block);
    for (const item of config.locations) {
      const home = known.find(entry => entry.name === item.name);
      assert.ok(home, item.name);
      // Only the spawn point is compared: the camera of .env.example is tuned by the user and the README examples are illustrations.
      assert.deepEqual([item.x, item.y, item.z, item.yaw], [home.x, home.y, home.z, home.yaw]);
    }
  }
});

// CHG-06 (STORY-01.09): camera aiming modes lookAt | yaw (+pitch) | default.
test("01.09: yaw mode stores yaw and pitch (default 0), frozen, without lookAt, and keeps the spawn point", () => {
  const [a, b] = load([entry("A", { camera: { x: 10, y: 20, z: 30, yaw: 90 } }), entry("B", { camera: { x: 10, y: 20, z: 30, yaw: -45.5, pitch: 12.25 } })]).locations;
  assert.deepEqual({ ...a.camera }, { x: 10, y: 20, z: 30, yaw: 90, pitch: 0 });
  assert.deepEqual({ ...b.camera }, { x: 10, y: 20, z: 30, yaw: -45.5, pitch: 12.25 });
  assert.ok(Object.isFrozen(a.camera) && !("lookAt" in a.camera));
  assert.deepEqual([a.x, a.y, a.z, a.yaw], [1, 2, 3, 4]);
});
test("01.09: yaw and pitch limits are inclusive (yaw -360..360, pitch -89..89)", () => {
  for (const yaw of [-360, 0, 360]) assert.equal(load([withCamera({ x: 10, y: 20, z: 30, yaw })]).locations.length, 1);
  for (const pitch of [-89, 0, 89]) assert.equal(load([withCamera({ x: 10, y: 20, z: 30, yaw: 0, pitch })]).locations.length, 1);
  for (const yaw of [360.01, -360.01, 1e9]) assert.throws(() => load([withCamera({ x: 10, y: 20, z: 30, yaw })]), camErr, String(yaw));
  for (const pitch of [89.01, -89.01, 90]) assert.throws(() => load([withCamera({ x: 10, y: 20, z: 30, yaw: 0, pitch })]), camErr, String(pitch));
});
test("01.09: fail-closed combinations: lookAt with yaw/pitch, pitch without yaw, null or non-numeric yaw/pitch (G33)", () => {
  const P = { x: 10, y: 20, z: 30 }, L = { x: 5, y: 6, z: 7 };
  const bad = [{ ...P, lookAt: L, yaw: 0 }, { ...P, lookAt: L, pitch: 0 }, { ...P, lookAt: L, yaw: 0, pitch: 0 }, { ...P, pitch: 10 },
    { ...P, yaw: null }, { ...P, yaw: "90" }, { ...P, yaw: NaN }, { ...P, yaw: Infinity }, { ...P, yaw: true }, { ...P, yaw: [1] }, { ...P, yaw: undefined, pitch: 1 },
    { ...P, yaw: 0, pitch: null }, { ...P, yaw: 0, pitch: "5" }, { ...P, yaw: 0, pitch: NaN }, { ...P, yaw: 0, pitch: {} }, { ...P, pitch: null }];
  for (const camera of bad) assert.throws(() => load([withCamera(camera)]), camErr, JSON.stringify(camera));
  assert.throws(() => load('[{"name":"A","x":1,"y":2,"z":3,"yaw":4,"camera":{"x":1,"y":2,"z":9,"yaw":1e999}}]'), camErr);
});
test("01.09: G21 does not apply to yaw mode (camera may sit at the spawn point) but still applies to lookAt and default", () => {
  assert.equal(load([withCamera({ x: 1, y: 2, z: 3, yaw: 10 })]).locations.length, 1);
  assert.throws(() => load([withCamera({ x: 1, y: 2, z: 3 })]), camErr);
  assert.throws(() => load([withCamera({ x: 1, y: 2, z: 3, lookAt: { x: 1, y: 2, z: 3 } })]), camErr);
});
test("01.09: the yaw error names location and field, never a value", () => {
  try { load([withCamera({ x: 1, y: 2, z: 3, yaw: "secreto-123" })]); assert.fail("expected"); }
  catch (error) { assert.equal(error.code, "LOCATION_CAMERA_INVALID"); assert.match(error.message, /Cam/); assert.match(error.message, /camera\.yaw/); assert.doesNotMatch(error.message, /secreto|123/); }
  try { load([withCamera({ x: 1, y: 2, z: 3, yaw: 0, pitch: 500 })]); assert.fail("expected"); }
  catch (error) { assert.match(error.message, /camera\.pitch/); }
});
