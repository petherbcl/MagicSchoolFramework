Events.on("resourceStart", (resourceName) => {
  if (resourceName !== "my-gamemode") return;
  console.log("started");

  // Server-authoritative environment, replicated to every client.
  World.setTime(15, 30);
  World.setSeason(3);
  World.setWeather("Snow_01");
});

// ms-core emits this only after verified authentication, allowlist and restore.
Events.on("ms:playerReady", ({ playerId, userId, sessionId }) => {
  const Core = Exports.get("ms-core", "Core");
  if (Core.Users.get(playerId)?.sessionId !== sessionId) return;
  if (!Core.Users.isReady(playerId)) return;
  const player = PlayerManager.getById(playerId);
  if (!player) return;
  console.log(`Account ${userId} entered the world`);
  player.sendChat(`Welcome to the castle, ${player.nickname}!`);
});
