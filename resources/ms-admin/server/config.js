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
  return Object.freeze({ role });
}
module.exports = { loadConfig };
