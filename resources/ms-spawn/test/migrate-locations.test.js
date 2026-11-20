"use strict";
// CHG-05 (STORY-06.11): tools/migrate-locations.js converts the old MS_SPAWN_LOCATIONS format and only prints.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { run, migrate } = require("../tools/migrate-locations");
const { loadConfig } = require("../server/config");
const { cameraPose, locationPose } = require("../server/spawn");

const TOOL = path.join(__dirname, "..", "tools", "migrate-locations.js");
const OLD = [{ name: "Sala Comum Slytherin", role: "slytherin", icon: "slytherin.png", x: 359573, y: -451727.25, z: -85308.25, yaw: -146.48 }, { name: "Hogsmeade", x: 395037.5, y: -519061, z: -82090.25, yaw: 112.24 }];

function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-spawn-migrate-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const envFile = (dir, locations, extra = "") => { const file = path.join(dir, ".env"); fs.writeFileSync(file, `SECRET_TOKEN=do-not-print\nMS_SPAWN_LOCATIONS='${JSON.stringify(locations)}'\n${extra}`); return file; };
const parsed = result => { const line = result.stdout.trim(); assert.ok(line.startsWith("MS_SPAWN_LOCATIONS='") && line.endsWith("'"), line.slice(0, 40)); return JSON.parse(line.slice("MS_SPAWN_LOCATIONS='".length, -1)); };
const snapshot = dir => fs.readdirSync(dir).map(name => { const s = fs.statSync(path.join(dir, name)); return [name, s.mtimeMs, fs.readFileSync(path.join(dir, name), "utf8")]; });

test("an old env file is migrated: camera from the derived pose with the file's DISTANCE and HEIGHT, and the result passes the real config", t => {
  const dir = tmp(t), file = envFile(dir, OLD, "MS_SPAWN_CAMERA_DISTANCE=900\nMS_SPAWN_CAMERA_HEIGHT=250\n");
  const result = run([file], { env: {} });
  assert.equal(result.code, 0);
  const list = parsed(result);
  for (const [index, entry] of list.entries()) {
    const { position } = cameraPose(OLD[index], { distance: 900, height: 250 });
    assert.deepEqual(entry.camera, position);
    assert.equal("lookAt" in entry.camera, false);
  }
  const config = loadConfig({ MS_SPAWN_LOCATIONS: JSON.stringify(list) }, { envFile: null });
  assert.equal(config.locations.length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET|do-not-print/);
});
test("the migrated location gives the same view as the old rule (position equal, rotation within rounding)", t => {
  const dir = tmp(t), file = envFile(dir, OLD);
  const config = loadConfig({ MS_SPAWN_LOCATIONS: JSON.stringify(parsed(run([file], { env: {} }))) }, { envFile: null });
  for (const [index, location] of config.locations.entries()) {
    const old = cameraPose(OLD[index], { distance: 1200, height: 600 }), now = locationPose(location);
    assert.deepEqual(now.position, old.position);
    assert.ok(Math.abs(now.rotation.pitch - old.rotation.pitch) <= 0.011 && Math.abs(now.rotation.yaw - old.rotation.yaw) <= 0.011);
  }
});
test("process variables override the file for DISTANCE and HEIGHT; invalid ones fail", t => {
  const dir = tmp(t), file = envFile(dir, OLD, "MS_SPAWN_CAMERA_DISTANCE=900\n");
  assert.deepEqual(parsed(run([file], { env: { MS_SPAWN_CAMERA_DISTANCE: "500", MS_SPAWN_CAMERA_HEIGHT: "0" } }))[1].camera, cameraPose(OLD[1], { distance: 500, height: 0 }).position);
  assert.equal(run([file], { env: { MS_SPAWN_CAMERA_DISTANCE: "5" } }).code, 1);
});
test("a JSON file with the locations array works; --json prints only the array", t => {
  const dir = tmp(t), file = path.join(dir, "old.json"); fs.writeFileSync(file, JSON.stringify(OLD));
  const result = run([file, "--json"], { env: {} });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).length, 2);
});
test("role and icon are kept and entries that already have a camera stay unchanged", t => {
  const dir = tmp(t), mixed = [OLD[0], { ...OLD[1], camera: { x: 1, y: 2, z: 3, lookAt: { x: 4, y: 5, z: 6 } } }];
  const list = parsed(run([envFile(dir, mixed)], { env: {} }));
  assert.equal(list[0].role, "slytherin"); assert.equal(list[0].icon, "slytherin.png");
  assert.deepEqual(list[1], mixed[1]);
  assert.deepEqual(list.map(e => e.name), OLD.map(e => e.name));
});
test("an empty list migrates to an empty list", t => {
  assert.deepEqual(parsed(run([envFile(tmp(t), [])], { env: {} })), []);
});
test("invalid input exits non-zero with a clear message and no copy of the file", t => {
  const dir = tmp(t);
  const cases = [["MS_SPAWN_LOCATIONS='[{'\nSECRET=zzz\n", /not valid JSON/], ["SECRET=zzz\n", /not set/], [`MS_SPAWN_LOCATIONS='[{"name":"A","y":1,"z":1,"yaw":1}]'\nSECRET=zzz\n`, /entry 0 has no valid x/],
    [`MS_SPAWN_LOCATIONS='{"a":1}'\n`, /not a JSON array/], [`MS_SPAWN_LOCATIONS='[5]'\n`, /not an object/], [`MS_SPAWN_LOCATIONS='[{"name":"A","x":1,"y":1,"z":1,"yaw":1,"role":"BAD"}]'\n`, /LOCATION_ROLE_INVALID/]];
  for (const [content, pattern] of cases) {
    const file = path.join(dir, "case.env"); fs.writeFileSync(file, content);
    const result = run([file], { env: {} });
    assert.equal(result.code, 1, content); assert.equal(result.stdout, ""); assert.match(result.stderr, pattern); assert.doesNotMatch(result.stderr, /zzz/);
  }
  assert.equal(run([path.join(dir, "missing.env")], { env: {} }).code, 1);
});
test("--help explains the use and says it never writes the .env; unknown options are a usage error", () => {
  const help = run(["--help"]);
  assert.equal(help.code, 0); assert.match(help.stdout, /NEVER writes any file/); assert.match(help.stdout, /\.env/);
  assert.equal(run(["--nope"]).code, 2); assert.equal(run(["a", "b"]).code, 2);
});
test("the default file is .env, falling back to .env.example", () => {
  const seen = [];
  const result = run([], { env: {}, exists: file => { seen.push(path.basename(file)); return false; } });
  assert.deepEqual(seen, [".env"]);
  assert.equal(result.code, 0); assert.match(result.stderr, /using \.env\.example/);
  assert.equal(parsed(result).length, 6); // the shipped example is already migrated: entries with a camera pass through unchanged
});
test("the CLI never writes or touches a file, including on errors", t => {
  const dir = tmp(t), file = envFile(dir, OLD), bad = path.join(dir, "bad.env"); fs.writeFileSync(bad, "MS_SPAWN_LOCATIONS='[{'\n");
  const before = snapshot(dir);
  for (const args of [[file], [bad], ["--help"], [path.join(dir, "missing")]]) {
    const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: dir, encoding: "utf8" });
    assert.ok([0, 1].includes(result.status), String(result.status));
  }
  assert.deepEqual(snapshot(dir), before);
  const source = fs.readFileSync(TOOL, "utf8");
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|\.rename|unlink|rmSync|mkdir|copyFile|openSync|truncate/);
  const cli = spawnSync(process.execPath, [TOOL, file], { encoding: "utf8" });
  assert.equal(cli.status, 0); assert.match(cli.stdout, /^MS_SPAWN_LOCATIONS='/); assert.match(cli.stderr, /nothing was written/);
});
test("migrate() is pure: the input is not mutated", () => {
  const input = JSON.parse(JSON.stringify(OLD));
  migrate(input, { distance: 1200, height: 600 });
  assert.deepEqual(input, OLD);
});

test("CHG-06 (02.18/06.16): migrated cameras stay in the default aiming mode: only x,y,z, looking at the spawn point as before", t => {
  const dir = tmp(t), result = run([envFile(dir, OLD)], { env: {} });
  assert.equal(result.code, 0);
  const list = parsed(result);
  const config = loadConfig({ MS_SPAWN_LOCATIONS: JSON.stringify(list) }, { envFile: null });
  for (const [index, entry] of list.entries()) {
    assert.deepEqual(Object.keys(entry.camera), ["x", "y", "z"]);
    const loc = config.locations[index], old = cameraPose(OLD[index], { distance: 1200, height: 600 });
    assert.deepEqual(Object.keys(loc.camera).sort(), ["lookAt", "x", "y", "z"]);
    assert.deepEqual({ ...loc.camera.lookAt }, { x: OLD[index].x, y: OLD[index].y, z: OLD[index].z });
    const pose = locationPose(loc);
    assert.ok(Math.abs(pose.rotation.pitch - old.rotation.pitch) <= 0.011 && Math.abs(pose.rotation.yaw - old.rotation.yaw) <= 0.011);
  }
});
