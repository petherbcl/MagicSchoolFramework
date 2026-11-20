#!/usr/bin/env node
"use strict";

// CHG-05 migration helper. Reads MS_SPAWN_LOCATIONS in the OLD format (no per-location `camera`) from an env file or a JSON file and
// PRINTS the new value to stdout, with `camera` filled from the pose ms-spawn used to derive (the spawn point,
// MS_SPAWN_CAMERA_DISTANCE cm behind it and MS_SPAWN_CAMERA_HEIGHT cm above it, looking at the spawn point), so the view stays the
// same until the camera is tuned by hand. It never writes any file: only stdout/stderr and an exit code.
// Only MS_SPAWN_LOCATIONS, MS_SPAWN_CAMERA_DISTANCE and MS_SPAWN_CAMERA_HEIGHT are read; nothing else of the file is used or printed.

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { loadConfig } = require("../server/config");
const { cameraPose } = require("../server/spawn");

const RESOURCE_DIR = path.resolve(__dirname, "..");
const HELP = `Usage: node resources/ms-spawn/tools/migrate-locations.js [file] [--json]

Converts MS_SPAWN_LOCATIONS from the old format (no per-location "camera") to the CHG-05 format and PRINTS it.
It NEVER writes any file, including your .env: copy the printed line into your .env yourself.

  file     an env file (default: resources/ms-spawn/.env, else resources/ms-spawn/.env.example) or a .json file holding
           the locations array. MS_SPAWN_CAMERA_DISTANCE and MS_SPAWN_CAMERA_HEIGHT are taken from the file (env files) or
           the process environment, else the defaults 1200 and 600.
  --json   print only the JSON array (default: a ready-to-paste MS_SPAWN_LOCATIONS line)
  --help   this text

Each location gets camera = its spawn point moved DISTANCE cm behind (opposite to its yaw) and HEIGHT cm above, looking at the
spawn point (no lookAt: it defaults to the spawn point). Entries that already have a camera, and their role and icon, are kept.
Exit codes: 0 printed, 1 invalid input or result, 2 usage error.`;

class MigrateError extends Error {}
const fail = message => { throw new MigrateError(message); };
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function readFile(file) {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return fail("cannot read the file"); }
}

// Pure: old-format list + { distance, height } -> new-format list. Never mutates the input.
function migrate(list, { distance, height }) {
  if (!Array.isArray(list)) fail("MS_SPAWN_LOCATIONS is not a JSON array");
  return list.map((entry, index) => {
    if (!isObject(entry)) fail(`entry ${index} is not an object`);
    if (entry.camera !== undefined) return entry; // already migrated (or malformed: the final validation reports it)
    for (const key of ["x", "y", "z", "yaw"]) if (typeof entry[key] !== "number" || !Number.isFinite(entry[key])) fail(`entry ${index} has no valid ${key}`);
    const { position } = cameraPose({ x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw }, { distance, height });
    return { ...entry, camera: position };
  });
}

// Returns { code, stdout, stderr } and touches no file. `env` is the process environment (overrides the file for DISTANCE/HEIGHT).
function run(argv, { env = process.env, exists = fs.existsSync } = {}) {
  const out = [], err = [];
  try {
    const flags = argv.filter(arg => arg.startsWith("--")), files = argv.filter(arg => !arg.startsWith("--"));
    if (flags.includes("--help") || flags.includes("-h") || argv.includes("-h")) return { code: 0, stdout: HELP + "\n", stderr: "" };
    if (flags.some(flag => flag !== "--json") || files.length > 1) return { code: 2, stdout: "", stderr: HELP + "\n" };
    let file = files[0], note = "";
    if (!file) {
      const own = path.join(RESOURCE_DIR, ".env");
      file = exists(own) ? own : path.join(RESOURCE_DIR, ".env.example");
      if (file !== own) note = "no .env found, using .env.example\n";
    }
    const text = readFile(file);
    let rawLocations, fileEnv = {};
    if (path.extname(file).toLowerCase() === ".json") {
      try { rawLocations = JSON.parse(text); } catch { fail("invalid JSON"); }
    } else {
      try { fileEnv = parseEnv(text); } catch { fail("cannot parse the env file"); }
      if (fileEnv.MS_SPAWN_LOCATIONS === undefined || fileEnv.MS_SPAWN_LOCATIONS.trim() === "") fail("MS_SPAWN_LOCATIONS is not set in the file");
      try { rawLocations = JSON.parse(fileEnv.MS_SPAWN_LOCATIONS); } catch { fail("MS_SPAWN_LOCATIONS is not valid JSON"); }
    }
    // Same parsing and limits as the real config (only these two keys are taken; invalid values fail like the resource would).
    const settings = {};
    for (const key of ["MS_SPAWN_CAMERA_DISTANCE", "MS_SPAWN_CAMERA_HEIGHT"]) { const value = env[key] !== undefined ? env[key] : fileEnv[key]; if (value !== undefined) settings[key] = value; }
    let camera;
    try { camera = loadConfig(settings, { envFile: null }).camera; } catch (error) { fail("invalid " + (error.message.split(": ")[1] || "camera setting")); }
    const migrated = migrate(rawLocations, camera);
    const json = JSON.stringify(migrated);
    // The result must pass the real config (it also catches invalid roles, icons, names, numbers).
    try { loadConfig({ MS_SPAWN_LOCATIONS: json }, { envFile: null }); } catch (error) { fail("the migrated result would not be accepted by ms-spawn (" + (error.code || "invalid") + (error.message.includes(": ") ? ": " + error.message.split(": ").slice(1).join(": ") : "") + ")"); }
    if (flags.includes("--json")) out.push(json);
    else {
      const quote = !json.includes("'") ? "'" : !json.includes("`") ? "`" : null;
      if (!quote) fail("the JSON contains both ' and `; rerun with --json and quote it yourself");
      out.push(`MS_SPAWN_LOCATIONS=${quote}${json}${quote}`);
    }
    err.push(note + `migrated ${migrated.length} location(s) with distance=${camera.distance} height=${camera.height}; nothing was written (copy the line above into resources/ms-spawn/.env)`);
    return { code: 0, stdout: out.join("\n") + "\n", stderr: err.join("\n") + "\n" };
  } catch (error) {
    if (!(error instanceof MigrateError)) throw error;
    return { code: 1, stdout: "", stderr: "migrate-locations: " + error.message + "\n" };
  }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

module.exports = { migrate, run, HELP };
