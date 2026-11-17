"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { UNIQUE_IDENTIFIERS } = require("./validation");

function readEnvFile(filename) {
  if (!filename) return {};
  try { return parseEnv(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("MS_CORE_ENV_FILE_UNREADABLE");
  }
}

function integer(env, key, fallback, min, max) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
function parseRequired(value) {
  const groups = new Map();
  for (const part of String(value || "").split(",")) {
    if (!part.trim()) continue;
    const kinds = [...new Set(part.split("|").map(kind => kind.trim()))];
    for (const kind of kinds) if (!UNIQUE_IDENTIFIERS.includes(kind)) throw new Error("Invalid MS_REQUIRED_IDENTIFIERS: " + (kind || part.trim()));
    const key = [...kinds].sort().join("|");
    if (!groups.has(key)) groups.set(key, Object.freeze(kinds));
  }
  return [...groups.values()];
}
function loadConfig(env = process.env, options = {}) {
  // Explicit test environments stay isolated unless a file is requested.
  const envFile = options.envFile !== undefined ? options.envFile :
    env === process.env ? path.resolve(__dirname, "../.env") : null;
  // Never mutate process.env or replace values explicitly supplied by the host.
  env = { ...readEnvFile(envFile), ...env };
  const databaseUrl = env.MS_DATABASE_URL || "";
  if (databaseUrl && !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error("MS_DATABASE_URL must be a PostgreSQL connection string");
  const serverKey = env.MS_SERVER_KEY || "MagicSchoolRP";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverKey)) throw new Error("Invalid MS_SERVER_KEY");
  let formUrl = env.MS_ALLOWLIST_FORM_URL || "";
  if (formUrl) {
    const url = new URL(formUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MS_ALLOWLIST_FORM_URL");
    formUrl = url.href;
  }
  // Comma-separated account identifiers that every connection must announce (e.g. "discordId,steamId").
  // "," means AND, "|" means OR within a group: "discordId,steamId|epicId" = Discord AND (Steam OR Epic).
  // Parsed into groups; each group needs at least one of its identifiers.
  const requiredIdentifiers = Object.freeze(parseRequired(env.MS_REQUIRED_IDENTIFIERS));
  return Object.freeze({
    databaseUrl, databaseConfigured: Boolean(databaseUrl), serverKey, formUrl, requiredIdentifiers,
    poolSize: integer(env, "MS_DATABASE_POOL_SIZE", 5, 1, 20), queryTimeoutMs: 10000,
    approvalTimeoutMs: integer(env, "MS_APPROVAL_TIMEOUT_SECONDS", 1800, 60, 86400) * 1000,
    accessPollMs: integer(env, "MS_ACCESS_POLL_SECONDS", 5, 1, 60) * 1000,
    saveIntervalMs: integer(env, "MS_SAVE_INTERVAL_SECONDS", 30, 5, 300) * 1000,
    maxCharacters: integer(env, "MS_MAX_CHARACTERS", 1, 1, 5),
    maxSessions: 128, quarantineWorldBase: 3000000000,
    spawn: { position: { x: 366784, y: -461527, z: -82610 }, yaw: -130 },
    rolePermissions: { player: ["characters.create", "characters.select", "users.metadata.self"],
      moderator: ["users.read", "allowlist.manage", "bans.manage"], admin: ["*"] },
  });
}
module.exports = { loadConfig };
