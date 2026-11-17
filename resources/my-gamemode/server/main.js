Events.on("resourceStart", (resourceName) => {
  if (resourceName !== "my-gamemode") return;
  console.log("started");

  // Server-authoritative environment, replicated to every client.
  World.setTime(15, 30);
  World.setSeason(3);
  World.setWeather("Snow_01");
});

// ms-character emits this after the account is ready (ms-core) and a character is restored.
Events.on("ms:characterReady", ({ playerId, userId, sessionId, characterId }) => {
  const Core = Exports.get("ms-core", "Core");
  if (Core.Users.get(playerId)?.sessionId !== sessionId) return;
  if (!Core.Users.isReady(playerId)) return;
  if (!Exports.get("ms-character", "Characters").isPlaying(playerId)) return;
  const player = PlayerManager.getById(playerId);
  if (!player) return;
  console.log(`Account ${userId} entered the world with character ${characterId}`);
  player.sendChat(`Welcome to the castle, ${player.nickname}!`);
});
