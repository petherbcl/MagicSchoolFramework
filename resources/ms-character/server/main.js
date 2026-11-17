"use strict";
const { loadConfig } = require("./config");
const { Repository } = require("./database/repository");
const { createLobby } = require("./lobby");
const { createGameAdapter } = require("./game");
const { CharacterError } = require("./validation");
let lobby, repository, game, config, saveTimer, ready = false;
// Resolved on every call so an "ensure ms-core" reload never leaves a stale export behind.
const Core = { Users: {
  get: id => Exports.get("ms-core", "Core")?.Users.get(id) ?? null,
  isReady: id => Boolean(Exports.get("ms-core", "Core")?.Users.isReady(id)),
} };
const messages = { INVALID_NAME: "Usa nomes com 2 a 32 letras.", INVALID_HOUSE: "Escolhe uma casa válida.",
  INVALID_CHARACTER: "Dados de personagem inválidos.", CHARACTER_LIMIT: "Atingiste o limite de personagens.",
  CHARACTER_NOT_FOUND: "A personagem não pertence à tua conta.", INVALID_ID: "Personagem inválida.",
  RATE_LIMITED: "Aguarda antes de repetir.", INVALID_STATE: "Aguarda a etapa atual." };

// Errors with a known code become a notice; anything else kicks (the native state is unknown).
function safe(player, fn) {
  const same = lobby?.guard(player.id) || (() => false);
  Promise.resolve().then(() => { if (same()) return fn(); }).catch(error => {
    if (!same()) return;
    if (error instanceof CharacterError && messages[error.code]) player.emit("ms-character:notice", JSON.stringify({ text: messages[error.code] }));
    else if (!(error instanceof CharacterError)) { console.error("[ms-character] operation failed: " + (error.code || error.name)); player.kick("Erro na seleção de personagens. Tenta novamente."); }
  });
}
function openLobby(player, session) {
  lobby.open(player, session).catch(error => console.error("[ms-character] lobby failed: " + (error.code || error.name)));
}
// ms-core emits this after approval, key check and world load; re-verify the session first.
Events.on("ms:playerReady", ({ playerId, sessionId, userId }) => {
  if (!ready || Core.Users.get(playerId)?.sessionId !== sessionId || !Core.Users.isReady(playerId)) return;
  const player = PlayerManager.getById(playerId);
  if (player) openLobby(player, { sessionId, userId });
});
Events.on("ms:sessionEnded", ({ sessionId }) => { if (ready) lobby.sessionEnded(sessionId); });
Events.on("playerDisconnect", player => { if (lobby) lobby.disconnect(player.id).catch(() => console.error("[ms-character] disconnect save failed")); });
Events.on("playerTeleportComplete", (player, requestId, status) => game?.complete(player.id, "teleport", requestId, status));
Events.on("playerMapTravelComplete", (player, requestId, status) => game?.complete(player.id, "map", requestId, status));
Events.onClient("ms-character:sync", player => { if (ready) safe(player, () => lobby.sync(player.id)); });
Events.onClient("ms-character:create", (player, input) => { if (ready) safe(player, () => lobby.create(player.id, input)); });
Events.onClient("ms-character:select", (player, input) => {
  if (ready && input && typeof input.characterId === "string" && input.characterId.length <= 19) safe(player, () => lobby.select(player.id, input.characterId));
});
Events.on("resourceStart", async name => {
  if (name !== "ms-character") return;
  config = loadConfig();
  if (!config.databaseConfigured) { console.error("[ms-character] set MS_DATABASE_URL (ms-character/.env or ms-core/.env); character lobby disabled"); return; }
  try {
    if (typeof Exports.get("ms-core", "Core")?.Users?.isReady !== "function") throw new Error("MS_CORE_EXPORT_MISSING");
    repository = new Repository(config); await repository.createSchema();
    game = createGameAdapter(config);
    lobby = createLobby({ repository, config, game, core: Core, emit: (event, payload) => Events.emit(event, payload) });
    if (!Exports.register("Characters", lobby.api)) throw new Error("EXPORT_REGISTRATION_FAILED");
    ready = true;
    saveTimer = setInterval(() => lobby.saveAll().catch(() => console.error("[ms-character] autosave failed")), config.saveIntervalMs);
    // Players already approved before a (re)start go to the lobby too.
    for (const player of PlayerManager.getAll()) {
      const session = Core.Users.get(player.id);
      if (session && Core.Users.isReady(player.id)) openLobby(player, { sessionId: session.sessionId, userId: session.userId });
    }
    console.log("[ms-character] character lobby ready");
  } catch (error) {
    ready = false; if (lobby) await lobby.stop(); if (repository) await repository.close();
    console.error("[ms-character] startup failed: " + (error.code || error.message || error.name)); throw new Error("MS_CHARACTER_STARTUP_FAILED");
  }
});
Events.on("resourceStop", async name => {
  if (name !== "ms-character") return;
  ready = false; if (saveTimer) clearInterval(saveTimer);
  if (lobby) await lobby.stop(); if (repository) await repository.close();
});
