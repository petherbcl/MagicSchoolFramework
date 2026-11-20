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
const ENTRY_KEYS = Object.freeze(["name", "x", "y", "z", "yaw", "role", "icon", "camera"]);
const CAMERA_KEYS = Object.freeze(["x", "y", "z", "lookAt", "yaw", "pitch"]);
const CAMERA_YAW_MAX = 360, CAMERA_PITCH_MAX = 89; // CHG-06, degrees (inclusive)
const POINT_KEYS = Object.freeze(["x", "y", "z"]);
// CHG-05: optional icon = a file name inside ui-src/public/icons/ (served to the page as icons/<name>); no path separators possible.
const ICON_PATTERN = /^[a-z0-9_-]+\.(png|webp|jpg|jpeg|svg)$/;
const ICON_MAX = 64;
// CHG-04: optional role per location, same character class as ms-core role names; empty or missing = open to everyone.
const ROLE_PATTERN = /^[a-z0-9_-]{1,32}$/;
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
// Strict boolean: "true"/"false" (any case) or "1"/"0"; empty or unset = fallback; anything else fails closed (CHG-03).
function flag(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fail("BOOLEAN_CONFIG_INVALID", key);
}
// "Sala Comum Slytherin" -> "sala-comum-slytherin": lowercase, accents removed (NFD), non [a-z0-9] runs become "-".
function slugify(name) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function finiteWithin(value, bound) { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= bound; }

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
// CHG-05/CHG-06: { x, y, z } plus ONE aiming: lookAt {x,y,z} (CHG-05), or yaw (-360..360) with optional pitch (-89..89, default 0), or
// neither (look at the spawn point, G2/G21). Every number finite; position and lookAt within the coordinate bound. lookAt with yaw or
// pitch, pitch without yaw, and a null/non-numeric/out-of-range yaw or pitch (G33) are invalid. The result is frozen in depth: the
// lookAt and default modes carry `lookAt`; the yaw mode carries `yaw` and `pitch` (and no lookAt). A camera that coincides with its
// aim point has no direction: invalid (lookAt and default modes only). Errors name the location and the field, never the value.
function parseCamera(value, spawn, where) {
  const invalid = field => fail("LOCATION_CAMERA_INVALID", `${where} camera${field ? "." + field : ""}`);
  if (!isObject(value)) invalid("");
  if (Object.keys(value).some(key => !CAMERA_KEYS.includes(key))) invalid("");
  for (const key of POINT_KEYS) if (!finiteWithin(value[key], COORDINATE_BOUND)) invalid(key);
  const position = { x: value.x, y: value.y, z: value.z };
  const has = key => Object.prototype.hasOwnProperty.call(value, key);
  if (has("yaw") || has("pitch")) {
    if (has("lookAt")) invalid("lookAt");
    if (!has("yaw")) invalid("pitch");
    if (!finiteWithin(value.yaw, CAMERA_YAW_MAX)) invalid("yaw");
    if (has("pitch") && !finiteWithin(value.pitch, CAMERA_PITCH_MAX)) invalid("pitch");
    return Object.freeze({ ...position, yaw: value.yaw, pitch: has("pitch") ? value.pitch : 0 });
  }
  let lookAt = { x: spawn.x, y: spawn.y, z: spawn.z };
  if (value.lookAt !== undefined) {
    const raw = value.lookAt;
    if (!isObject(raw) || Object.keys(raw).some(key => !POINT_KEYS.includes(key))) invalid("lookAt");
    for (const key of POINT_KEYS) if (!finiteWithin(raw[key], COORDINATE_BOUND)) invalid("lookAt." + key);
    lookAt = { x: raw.x, y: raw.y, z: raw.z };
  }
  if (samePoint(position, lookAt)) invalid(value.lookAt === undefined ? "" : "lookAt");
  return Object.freeze({ ...position, lookAt: Object.freeze(lookAt) });
}

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
    // The role never takes part in the id or in the uniqueness checks. Wrong type or characters fail closed; an unknown role is fine (never matches).
    if (entry.role !== undefined && (typeof entry.role !== "string" || (entry.role !== "" && !ROLE_PATTERN.test(entry.role)))) fail("LOCATION_ROLE_INVALID", where);
    // CHG-05: icon is a validated file name only; "" and null mean no icon (like role). It never takes part in the id or uniqueness.
    const icon = entry.icon === undefined || entry.icon === null || entry.icon === "" ? null : entry.icon;
    if (icon !== null && (typeof icon !== "string" || icon.length > ICON_MAX || !ICON_PATTERN.test(icon))) fail("LOCATION_ICON_INVALID", where);
    // CHG-05: the camera is mandatory for every configured location (an old-format entry fails closed until migrated).
    const camera = parseCamera(entry.camera, entry, `${where} (${JSON.stringify(name)})`);
    names.add(name.toLowerCase()); ids.add(id);
    locations.push(Object.freeze({ id, name, x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw, ...(entry.role ? { role: entry.role } : {}), ...(icon ? { icon } : {}), camera }));
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
    // CHG-03: the preview teleport of every select asks the game for snapToGround only when true (the invisible held player only
    // streams the world; the game holds a snapping player until the floor loads, up to 20 s). ms-character's own teleport is unaffected.
    previewSnapToGround: flag(env, "MS_SPAWN_PREVIEW_SNAP_TO_GROUND", false),
    // CHG-03: one server log line per select teleport result and a client console line per select (calibration of the loading).
    timingLog: flag(env, "MS_SPAWN_TIMING_LOG", true),
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
