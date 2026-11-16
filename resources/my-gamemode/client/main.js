Events.on("resourceStart", (resourceName) => {
  if (resourceName !== "my-gamemode") return;

  // The server welcomes the player after ms-core has completed authentication.
});

// Sent by the server with Events.emitAllClients or player.emit.
Events.on("mygm:announce", (payload) => {
  Game.notify(payload.text);
});
