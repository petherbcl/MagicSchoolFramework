"use strict";
const { loadConfig } = require("./config");
const { Repository } = require("./database/repository");
const { createLobby } = require("./lobby");
const { createGameAdapter } = require("./game");
const { CharacterError } = require("./validation");
let lobby, repository, game, config, saveTimer, purgeTimer, ready = false;
const STARTUP_DB_WAIT_MS = 10000;
// ms-sql owns the connection. Resolved lazily on every use so an `ensure ms-sql` reload never leaves a stale export.
function sqlApi() { try { return Exports.get("ms-sql", "Sql") || null; } catch { return null; } }
// Player requests are served only while the lobby is started and the database is reachable.
const open = () => ready && sqlApi()?.isReady() === true;
// Resolved on every call so an "ensure ms-core" reload never leaves a stale export behind.
const Core = { Users: {
  get: id => Exports.get("ms-core", "Core")?.Users.get(id) ?? null,
  isReady: id => Boolean(Exports.get("ms-core", "Core")?.Users.isReady(id)),
}, Players: {
  enterGame: (id, input) => Exports.get("ms-core", "Core").Players.enterGame(id, input),
} };
const messages = { INVALID_NAME: "Usa nomes com 2 a 32 letras.", INVALID_HOUSE: "Escolhe uma casa válida.",
  INVALID_CHARACTER: "Dados de personagem inválidos.", INVALID_LOOK: "Aparência inválida. Volta a tentar.",
  CHARACTER_LIMIT: "Atingiste o limite de personagens. Apaga uma personagem para criares outra.",
  CHARACTER_NOT_FOUND: "A personagem não pertence à tua conta.", INVALID_ID: "Personagem inválida.",
  CREATE_COOLDOWN: "Criaste demasiadas personagens nas últimas 24 horas. Tenta de novo mais tarde.",
  RATE_LIMITED: "Aguarda antes de repetir.", INVALID_STATE: "Aguarda a etapa atual." };
const DELETE_FAILED = "Não foi possível apagar a personagem. Tenta de novo; se o problema persistir, contacta a equipa.";
// Deleting never touches the native state, so its unexpected failures are a notice instead of a kick.
const deleteFailures = Object.freeze({ overrides: Object.freeze({ INVALID_STATE: DELETE_FAILED }), unexpected: DELETE_FAILED });

// Errors with a known code become a notice (per-operation overrides first). Anything else kicks, because the
// native state is unknown, unless the operation supplies its own `unexpected` notice.
// One RATE_LIMITED notice per player every 2 s: a flood of requests must not become a flood of notices (L-02).
const rateNoticeAt = new Map();
function safe(player, fn, { overrides = {}, unexpected = null } = {}) {
  const same = lobby?.guard(player.id) || (() => false);
  const notice = text => player.emit("ms-character:notice", JSON.stringify({ text }));
  Promise.resolve().then(() => { if (same()) return fn(); }).catch(error => {
    if (!same()) return;
    if (error instanceof CharacterError) {
      if (error.code === "RATE_LIMITED") {
        const now = Date.now();
        if (now - (rateNoticeAt.get(player.id) || 0) < 2000) return;
        rateNoticeAt.set(player.id, now);
      }
      const text = overrides[error.code] || messages[error.code];
      if (text) notice(text);
      return;
    }
    console.error("[ms-character] operation failed: " + (error.code || error.name));
    if (unexpected) notice(unexpected); else player.kick("Erro na seleção de personagens. Tenta novamente.");
  });
}
function openLobby(player, session) {
  lobby.open(player, session).catch(error => console.error("[ms-character] lobby failed: " + (error.code || error.name)));
}
// ms-core emits this after approval, key check and world load; re-verify the session first.
Events.on("ms:playerReady", ({ playerId, sessionId, userId }) => {
  if (!open() || Core.Users.get(playerId)?.sessionId !== sessionId || !Core.Users.isReady(playerId)) return;
  const player = PlayerManager.getById(playerId);
  if (player) openLobby(player, { sessionId, userId });
});
Events.on("ms:sessionEnded", ({ sessionId }) => { if (ready) lobby.sessionEnded(sessionId); });
Events.on("playerDisconnect", player => { rateNoticeAt.delete(player.id); if (lobby) lobby.disconnect(player.id).catch(() => console.error("[ms-character] disconnect save failed")); });
Events.on("playerTeleportComplete", (player, requestId, status) => game?.complete(player.id, "teleport", requestId, status));
Events.on("playerMapTravelComplete", (player, requestId, status) => game?.complete(player.id, "map", requestId, status));
Events.onClient("ms-character:sync", player => { if (open()) safe(player, () => lobby.sync(player.id)); });
Events.onClient("ms-character:create", (player, input) => { if (open()) safe(player, () => lobby.create(player.id, input)); });
Events.onClient("ms-character:select", (player, input) => {
  if (open() && input && typeof input.characterId === "string" && input.characterId.length <= 19) safe(player, () => lobby.select(player.id, input.characterId));
});
Events.onClient("ms-character:delete", (player, input) => {
  if (open() && input && typeof input.characterId === "string" && input.characterId.length <= 19) safe(player, () => lobby.delete(player.id, input.characterId), deleteFailures);
});
Events.on("resourceStart", async name => {
  if (name !== "ms-character") return;
  config = loadConfig();
  try {
    if (!sqlApi()) { console.error("[ms-character] the ms-sql export is unavailable (is ms-sql started?); character lobby disabled"); return; }
    try { await sqlApi().awaitConnection(STARTUP_DB_WAIT_MS); }
    catch (error) {
      if (error?.kind !== "NOT_READY") throw error;
      console.error("[ms-character] ms-sql has no database configured (set MS_SQL_URL in resources/ms-sql/.env); character lobby disabled"); return;
    }
    if (typeof Exports.get("ms-core", "Core")?.Users?.isReady !== "function") throw new Error("MS_CORE_EXPORT_MISSING");
    repository = new Repository(sqlApi); await repository.createTables();
    game = createGameAdapter(config);
    lobby = createLobby({ repository, config, game, core: Core, emit: (event, payload) => Events.emit(event, payload) });
    if (!Exports.register("Characters", lobby.api)) throw new Error("EXPORT_REGISTRATION_FAILED");
    ready = true;
    // Retention of soft-deleted characters (M-01): once now, then hourly.
    const purge = () => repository.purgeDeleted(config.deletedRetentionDays).catch(() => console.error("[ms-character] purge failed"));
    purge(); purgeTimer = setInterval(purge, 3600000);
    saveTimer = setInterval(() => lobby.saveAll().catch(() => console.error("[ms-character] autosave failed")), config.saveIntervalMs);
    // Players already approved before a (re)start go to the lobby too.
    for (const player of PlayerManager.getAll()) {
      const session = Core.Users.get(player.id);
      if (session && Core.Users.isReady(player.id)) openLobby(player, { sessionId: session.sessionId, userId: session.userId });
    }
    console.log("[ms-character] character lobby ready");
  } catch (error) {
    ready = false; if (lobby) await lobby.stop();
    console.error("[ms-character] startup failed: " + (error.code || error.message || error.name)); throw new Error("MS_CHARACTER_STARTUP_FAILED");
  }
});
Events.on("resourceStop", async name => {
  if (name !== "ms-character") return;
  ready = false; if (saveTimer) clearInterval(saveTimer); if (purgeTimer) clearInterval(purgeTimer);
  if (lobby) await lobby.stop();
});
