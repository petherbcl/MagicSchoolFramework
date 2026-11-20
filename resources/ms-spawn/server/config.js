"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

// Configuration error with a stable code. The message never carries configuration values.
class SpawnConfigError extends Error {
  constructor(code, detail = "") { super(detail ? `${code}: ${detail}` : code); this.name = "SpawnConfigError"; this.code = code; }
}
const fail = (code, detail) => { throw new SpawnConfigError(code, detail); };

const MAX_LOCATIONS = 12;
const NAME_MAX = 40;
const RESERVED_ID = "last";
const COORDINATE_BOUND = 1e7; // centimetres; the Overland map is far smaller
const ENTRY_KEYS = Object.freeze(["name", "x", "y", "z", "yaw"]);
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u; // control and format characters (bidi overrides, zero width) and line/paragraph separators
const EASINGS = Object.freeze(["linear", "smoothStep", "easeIn", "easeOut", "easeInOut"]);
const LOCATIONS_MAX_CHARS = 16384;

function readEnvFile(filename) {
  if (!filename) return {};
  try { return parseEnv(fs.readFileSync(filename, "utf8").replace(/^﻿/, "")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    return fail("ENV_FILE_UNREADABLE");
  }
}
function number(env, key, fallback, min, max) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value < min || value > max) fail("CAMERA_CONFIG_INVALID", key);
  return value;
}
// "Sala Comum Slytherin" -> "sala-comum-slytherin": lowercase, accents removed (NFD), non [a-z0-9] runs become "-".
function slugify(name) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function finiteWithin(value, bound) { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= bound; }

function parseLocations(raw) {
  if (raw === undefined || raw.trim() === "") return [];
  if (raw.length > LOCATIONS_MAX_CHARS) fail("LOCATIONS_TOO_LARGE");
  let list;
  try { list = JSON.parse(raw); } catch { return fail("LOCATIONS_INVALID_JSON"); }
  if (!Array.isArray(list)) fail("LOCATIONS_NOT_ARRAY");
  if (list.length > MAX_LOCATIONS) fail("LOCATIONS_TOO_MANY");
  const ids = new Set(), names = new Set(), locations = [];
  list.forEach((entry, index) => {
    const where = "entry " + index;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("LOCATION_INVALID_ENTRY", where);
    // Unknown keys fail closed too: a typo such as "yow" must not silently become a default.
    if (Object.keys(entry).some(key => !ENTRY_KEYS.includes(key))) fail("LOCATION_INVALID_ENTRY", where);
    if (typeof entry.name !== "string" || entry.name.length > NAME_MAX * 4) fail("LOCATION_NAME_INVALID", where);
    const name = entry.name.trim().normalize("NFC");
    if (name.length < 1 || name.length > NAME_MAX || CONTROL_CHARACTERS.test(entry.name)) fail("LOCATION_NAME_INVALID", where);
    const id = slugify(name);
    if (id === "") fail("LOCATION_ID_EMPTY", where);
    if (id === RESERVED_ID) fail("LOCATION_ID_RESERVED", where);
    if (names.has(name.toLowerCase())) fail("LOCATION_NAME_DUPLICATE", where);
    if (ids.has(id)) fail("LOCATION_ID_COLLISION", where);
    if (![entry.x, entry.y, entry.z].every(value => finiteWithin(value, COORDINATE_BOUND)) || !finiteWithin(entry.yaw, 360)) fail("LOCATION_NUMBER_INVALID", where);
    names.add(name.toLowerCase()); ids.add(id);
    locations.push(Object.freeze({ id, name, x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw }));
  });
  return locations;
}

// Precedence: process env > ms-spawn/.env. There is no database setting here: ms-spawn does not use ms-sql.
function loadConfig(env = process.env, options = {}) {
  const own = options.envFile !== undefined ? options.envFile : env === process.env ? path.resolve(__dirname, "../.env") : null;
  env = { ...readEnvFile(own), ...env };
  const easing = env.MS_SPAWN_CAMERA_EASING === undefined || env.MS_SPAWN_CAMERA_EASING === "" ? "easeInOut" : env.MS_SPAWN_CAMERA_EASING;
  if (!EASINGS.includes(easing)) fail("CAMERA_CONFIG_INVALID", "MS_SPAWN_CAMERA_EASING");
  return Object.freeze({
    locations: Object.freeze(parseLocations(env.MS_SPAWN_LOCATIONS)),
    camera: Object.freeze({
      durationMs: number(env, "MS_SPAWN_CAMERA_DURATION_MS", 1500, 300, 10000),
      easing,
      distance: number(env, "MS_SPAWN_CAMERA_DISTANCE", 1200, 100, 20000),
      height: number(env, "MS_SPAWN_CAMERA_HEIGHT", 600, 0, 20000),
      // CHG-02 (G13): the swoop starts this much higher and farther than the target pose (extra on top of height/distance).
      departureHeight: number(env, "MS_SPAWN_CAMERA_DEPARTURE_HEIGHT", 1500, 0, 20000),
      departureDistance: number(env, "MS_SPAWN_CAMERA_DEPARTURE_DISTANCE", 3000, 0, 20000),
    }),
    areaTimeoutMs: number(env, "MS_SPAWN_AREA_TIMEOUT_MS", 15000, 1000, 60000),
    // Liveness of the client page (SEC-03): a selection whose page never reports it opened is cancelled after this long,
    // and ms-character falls back to its default spawn. It is about a dead or absent client, never about an idle player.
    openAckTimeoutMs: number(env, "MS_SPAWN_OPEN_ACK_TIMEOUT_MS", 30000, 5000, 600000),
    // Minimum gap between two client requests of one player (select/confirm).
    actionGapMs: 200,
    // SEC-06: minimum gap between two native moves of one selection (latest select wins on a trailing timer), the number of
    // moves one selection may start, and how long it may stay unheld before it is cancelled to the default spawn.
    // The unheld bound exceeds the 25 s teleport timeout plus the gap, so a slow but healthy teleport is never cut.
    moveGapMs: 1500,
    maxMoves: 20,
    maxUnheldMs: 40000,
  });
}

module.exports = { loadConfig, slugify, SpawnConfigError, MAX_LOCATIONS, NAME_MAX, RESERVED_ID };
