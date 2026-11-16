#!/usr/bin/env node
"use strict";
const os = require("node:os");
const { loadConfig } = require("../server/config");
const { Repository } = require("../server/database/repository");
const help = `PostgreSQL administration (requires MS_DATABASE_URL):
  node resources/ms-core/tools/admin.js users
  node resources/ms-core/tools/admin.js show <numericId>
  node resources/ms-core/tools/admin.js approve <numericId>
  node resources/ms-core/tools/admin.js deny <numericId> <reason>
  node resources/ms-core/tools/admin.js role-add <numericId> <player|moderator|admin>
  node resources/ms-core/tools/admin.js role-remove <numericId> <role>
  node resources/ms-core/tools/admin.js ban <numericId> <minutes|permanent> <reason>
  node resources/ms-core/tools/admin.js unban <numericId>
  node resources/ms-core/tools/admin.js recover <newPendingId> <originalId>
Recovery requires operator verification of ownership, outside the game.`;
async function main(args = process.argv.slice(2)) {
  const [command, userId, value, ...rest] = args;
  if (!command || command === "--help") { console.log(help); return; }
  const config = loadConfig(); if (!config.databaseConfigured) throw new Error("Configure MS_DATABASE_URL");
  let operator = process.env.USERNAME || process.env.USER || "local";
  try { operator = os.userInfo().username; } catch { /* Optional OS profile. */ }
  const actor = "console:" + String(operator).replace(/[\r\n\0]/g, "").slice(0, 100);
  const db = new Repository(config);
  try {
    if (command !== "users" && !userId) throw new Error("Missing numericId");
    await db.createSchema();
    switch (command) {
      case "users": console.log(JSON.stringify(await db.listUsers(), null, 2)); break;
      case "show": console.log(JSON.stringify(await db.getUser(userId), null, 2)); break;
      case "approve": await db.setAllowlist(userId, "approved", actor); console.log("Allowlist approved."); break;
      case "deny": await db.setAllowlist(userId, "denied", actor, [value, ...rest].filter(Boolean).join(" ")); console.log("Allowlist denied."); break;
      case "role-add": case "role-remove":
        if (!Object.hasOwn(config.rolePermissions, value)) throw new Error("Unknown role");
        await db.setRole(userId, value, command === "role-add", actor); console.log("Role updated."); break;
      case "ban": {
        const minutes = Number(value);
        if (value !== "permanent" && (!Number.isInteger(minutes) || minutes < 1 || minutes > 5256000)) throw new Error("Invalid duration");
        await db.ban(userId, rest.join(" "), value === "permanent" ? null : Date.now() + minutes * 60000, actor); console.log("Ban saved."); break;
      }
      case "unban": await db.unban(userId, actor); console.log("Bans revoked."); break;
      case "recover": await db.recoverCredential(userId, value, actor); console.log("Credential reassigned. Reconnect with the new client."); break;
      default: throw new Error("Unknown command");
    }
  } finally { await db.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || "ADMIN_OPERATION_FAILED"); process.exitCode = 1; });
module.exports = { main };
