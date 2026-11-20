"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

function readEnvFile(filename) {
  if (!filename) return {};
  try { return parseEnv(fs.readFileSync(filename, "utf8").replace(/^﻿/, "")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("MS_CHARACTER_ENV_FILE_UNREADABLE");
  }
}
function integer(env, key, fallback, min, max) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
// "x,y,z,yaw" (centimetres and degrees), e.g. "349817,-466133,-84908,123". Strict: anything else fails closed.
function point(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const parts = String(env[key]).split(",").map(s => s.trim());
  const nums = parts.map(Number);
  if (parts.length !== 4 || parts.some(s => s === "") || !nums.every(Number.isFinite)
    || nums.slice(0, 3).some(n => Math.abs(n) > 1e7) || Math.abs(nums[3]) > 360) throw new Error(`Invalid ${key}`);
  return { position: { x: nums[0], y: nums[1], z: nums[2] }, yaw: nums[3] };
}
// Precedence: process env > ms-character/.env. There is no database setting here: ms-sql owns the connection.
function loadConfig(env = process.env, options = {}) {
  const own = options.envFile !== undefined ? options.envFile : env === process.env ? path.resolve(__dirname, "../.env") : null;
  env = { ...readEnvFile(own), ...env };
  return Object.freeze({
    maxCharacters: integer(env, "MS_MAX_CHARACTERS", 1, 1, 5),
    // Creation cap per account over 24 h, deleted characters included (M-01): create/delete cycles cannot grow the DB.
    maxCreationsPerDay: integer(env, "MS_MAX_CREATIONS_PER_DAY", 5, 1, 100),
    // Soft-deleted characters older than this are purged for good (they stay recoverable until then).
    deletedRetentionDays: integer(env, "MS_DELETED_RETENTION_DAYS", 30, 1, 3650),
    saveIntervalMs: integer(env, "MS_SAVE_INTERVAL_SECONDS", 30, 5, 300) * 1000,
    // Each lobby gets its own private virtual world; ms-core quarantine uses 3000000000+.
    lobbyWorldBase: 3100000000,
    // Where the player waits while choosing, and where a new character first appears (Overland).
    // Chosen by the user with /pos (docs/ms-character-runtime-findings.md §4.1). Note: player.hold has no yaw option.
    // Configurable as "x,y,z,yaw" through MS_LOBBY_POSITION and MS_SPAWN_POSITION (defaults below).
    lobby: point(env, "MS_LOBBY_POSITION", { position: { x: 349817, y: -466133, z: -84908 }, yaw: 123 }),
    spawn: point(env, "MS_SPAWN_POSITION", { position: { x: 366784, y: -461527, z: -82610 }, yaw: -130 }),
  });
}
module.exports = { loadConfig };
