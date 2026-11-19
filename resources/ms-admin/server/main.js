"use strict";
const { loadConfig } = require("./config");
const { createAdmin } = require("./commands");
const { createGameAdapter } = require("./game");

let admin = null, timer = null;
// Resolved on every call so an "ensure ms-core" reload never leaves a stale export behind.
const core = { Players: { get: id => Exports.get("ms-core", "Core")?.Players.get(id) ?? null } };
const chat = (player, text) => { try { Chat.sendToPlayer(player, text, { author: "ms-admin" }); } catch { /* disconnected */ } };

Events.on("resourceStart", name => {
  if (name !== "ms-admin") return;
  admin = createAdmin({ config: loadConfig(), core, game: createGameAdapter(), chat });
  timer = setInterval(() => admin.revalidate(id => PlayerManager.getById(id)), 2000);
  console.log("[ms-admin] started");
});
Events.on("resourceStop", name => { if (name === "ms-admin" && timer) { clearInterval(timer); timer = null; } });
Events.on("chatCommand", (player, message, command) => { if (admin) admin.handle(player, String(command).toLowerCase()); });
Events.on("ms:playerLeftGame", ({ playerId }) => {
  const player = PlayerManager.getById(playerId);
  if (admin && player) admin.clear(player);
});
Events.on("playerDisconnect", player => { if (admin) admin.clear(player); });
