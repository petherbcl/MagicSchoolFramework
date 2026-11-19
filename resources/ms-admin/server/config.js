"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

function readEnvFile(filename) {
  if (!filename) return {};
  try { return parseEnv(fs.readFileSync(filename, "utf8").replace(/^﻿/, "")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("MS_ADMIN_ENV_FILE_UNREADABLE");
  }
}

// `role` is the ms-core role required for every command. No database settings: roles come from ms-core.
function loadConfig(env = process.env, options = {}) {
  const envFile = options.envFile !== undefined ? options.envFile :
    env === process.env ? path.resolve(__dirname, "../.env") : null;
  env = { ...readEnvFile(envFile), ...env };
  const role = (env.MS_ADMIN_ROLE || "admin").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(role)) throw new Error("Invalid MS_ADMIN_ROLE");
  // Optional noclip effects. `noclipFx` is a Niagara/Cascade asset path (see /fxlist); when empty the adapter picks
  // the first catalog entry that looks like smoke. `noclipSkinFx` is a Player.setSkinFx name.
  const noclipFx = (env.MS_ADMIN_NOCLIP_FX || "").trim();
  const noclipSkinFx = (env.MS_ADMIN_NOCLIP_SKINFX || "").trim();
  if (noclipFx.length > 300 || noclipSkinFx.length > 64) throw new Error("Invalid MS_ADMIN_NOCLIP_FX");
  // Master switch for every noclip effect (smoke and skin FX). On by default.
  const rawEnabled = (env.MS_ADMIN_NOCLIP_FX_ENABLED || "true").trim().toLowerCase();
  if (!["true", "false", "1", "0"].includes(rawEnabled)) throw new Error("Invalid MS_ADMIN_NOCLIP_FX_ENABLED");
  const noclipFxEnabled = rawEnabled === "true" || rawEnabled === "1";
  return Object.freeze({ role, noclipFxEnabled, noclipFx, noclipSkinFx });
}
module.exports = { loadConfig };
