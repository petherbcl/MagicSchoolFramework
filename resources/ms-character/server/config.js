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
// Precedence: process env > ms-character/.env > ms-core/.env (shares MS_DATABASE_URL).
function loadConfig(env = process.env, options = {}) {
  const own = options.envFile !== undefined ? options.envFile : env === process.env ? path.resolve(__dirname, "../.env") : null;
  const core = options.coreEnvFile !== undefined ? options.coreEnvFile : env === process.env ? path.resolve(__dirname, "../../ms-core/.env") : null;
  env = { ...readEnvFile(core), ...readEnvFile(own), ...env };
  const databaseUrl = env.MS_DATABASE_URL || "";
  if (databaseUrl && !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error("MS_DATABASE_URL must be a PostgreSQL connection string");
  return Object.freeze({
    databaseUrl, databaseConfigured: Boolean(databaseUrl),
    poolSize: integer(env, "MS_CHARACTER_POOL_SIZE", 3, 1, 20), queryTimeoutMs: 10000,
    maxCharacters: integer(env, "MS_MAX_CHARACTERS", 1, 1, 5),
    saveIntervalMs: integer(env, "MS_SAVE_INTERVAL_SECONDS", 30, 5, 300) * 1000,
    // Each lobby gets its own private virtual world; ms-core quarantine uses 3000000000+.
    lobbyWorldBase: 3100000000,
    // Where the player waits while choosing, and where a new character first appears (Overland).
    // Chosen by the user with /pos (docs/ms-character-runtime-findings.md §4.1). Note: player.hold has no yaw option.
    lobby: { position: { x: 349817, y: -466133, z: -84908 }, yaw: 123 },
    spawn: { position: { x: 366784, y: -461527, z: -82610 }, yaw: -130 },
  });
}
module.exports = { loadConfig };
