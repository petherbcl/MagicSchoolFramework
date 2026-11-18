"use strict";
const { check, clone, publicId, CharacterError } = require("./validation");
const MAX_SAVE_FAILURES = 3;
const errorCode = error => error?.code || error?.name || "UNKNOWN";

// Character lobby state machine. Dependencies are injected so tests replace them:
// repository (PostgreSQL), game (native adapter), core (ms-core's Core export), emit (server events).
// Lifecycle per player: loading → lobby ⇄ creating | deleting → applying → playing → (closed)
function createLobby({ repository, config, game, core, emit = () => {}, logger = console, clock = Date.now }) {
  const lobbies = new Map();
  let closing = false, worldSequence = 0, tokenSequence = 0;
  // Native playerIds are reused and ms-core sessions can end mid-operation: re-check after every await.
  const valid = l => !closing && lobbies.get(l.playerId) === l &&
    core.Users.get(l.playerId)?.sessionId === l.sessionId && core.Users.isReady(l.playerId);
  const ensure = l => check(valid(l), "SESSION_EXPIRED");
  const lobbyOf = id => { const l = lobbies.get(id); check(l && valid(l), "SESSION_EXPIRED"); return l; };
  const summary = ({ characterId, firstName, lastName, house }) => ({ characterId, firstName, lastName, house });
  // Lobby payload for the account owner only: adds lastPlayedAt and the stored look (null for old characters).
  const lobbyCharacter = character => ({ ...summary(character), lastPlayedAt: character.lastPlayedAt || null, look: character.state?.look ?? null });
  const event = (name, value) => {
    try { Promise.resolve(emit(name, clone(value))).catch(() => logger.error("[ms-character] event handler failed: " + name)); }
    catch { logger.error("[ms-character] event handler failed: " + name); }
  };
  function send(l) {
    if (lobbies.get(l.playerId) !== l) return;
    game.send(l.player, "ms-character:state", { status: l.status, characters: l.characters.map(lobbyCharacter),
      maxCharacters: config.maxCharacters, characterId: l.character?.characterId || null });
  }
  // A refused ownership check leaves a trace (the throttle already caps how often this can happen), then rethrows.
  async function denied(l, action, characterId, error) {
    if (error?.code === "CHARACTER_NOT_FOUND") {
      await repository.audit(action, l.userId, { characterId: String(characterId).slice(0, 19) }).catch(() => logger.error("[ms-character] audit failed: " + action));
    }
    throw error;
  }
  function throttle(l) { check(clock() - l.lastActionAt >= 750, "RATE_LIMITED"); l.lastActionAt = clock(); }
  function save(l) {
    if (l.status !== "playing" || !l.character) return Promise.resolve(false);
    // Snapshot synchronously while a disconnect handle is still valid.
    let state;
    try { state = game.capture(l.player, clone(l.character.state)); }
    catch (error) { return Promise.reject(error); }
    const task = l.saveChain.catch(() => {}).then(async () => {
      l.character = await repository.save(l.character.characterId, l.userId, l.character.version, state);
      return true;
    });
    l.saveChain = task; return task;
  }
  function detach(l, kickMessage) {
    if (lobbies.get(l.playerId) !== l) return Promise.resolve();
    const saving = save(l);
    l.status = "closed"; lobbies.delete(l.playerId);
    try { game.cancel(l); } catch { logger.error("[ms-character] native cleanup failed"); }
    if (kickMessage) game.kick(l.player, kickMessage);
    return saving.then(() => {}, error => logger.error(`[ms-character] save failed during close: character ${l.character?.characterId} (${errorCode(error)})`));
  }
  // Called on ms:playerReady (approved account, quarantine already released by ms-core).
  async function open(player, { sessionId, userId }) {
    check(!closing, "LOBBY_STOPPING");
    if (lobbies.has(player.id)) await detach(lobbies.get(player.id));
    const l = { playerId: player.id, player, sessionId, userId, status: "loading", characters: [], character: null,
      world: config.lobbyWorldBase + (++worldSequence), token: ++tokenSequence, lastActionAt: 0, saveChain: Promise.resolve(), saveFailures: 0 };
    lobbies.set(player.id, l);
    try {
      ensure(l);
      game.enterLobby(player, l);
      send(l);
      l.characters = await repository.list(userId); ensure(l);
      l.status = "lobby"; send(l);
      event("ms:characterLobby", { playerId: l.playerId, sessionId, userId, characters: l.characters.length });
      return l.characters.map(summary);
    } catch (error) {
      if (lobbies.get(l.playerId) === l) await detach(l, "Não foi possível abrir a seleção de personagens.");
      throw error;
    }
  }
  async function create(playerId, input) {
    const l = lobbyOf(playerId); check(l.status === "lobby", "INVALID_STATE"); throttle(l);
    l.status = "creating";
    try {
      const character = await repository.create(l.userId, input, config.maxCharacters, config.maxCreationsPerDay); ensure(l);
      l.characters = await repository.list(l.userId); ensure(l);
      return summary(character);
    } finally { if (lobbies.get(l.playerId) === l && l.status === "creating") { l.status = "lobby"; send(l); } }
  }
  // Soft delete, only from the lobby; the repository checks ownership and writes the audit row.
  async function remove(playerId, characterId) {
    const l = lobbyOf(playerId); check(l.status === "lobby", "INVALID_STATE"); throttle(l);
    l.status = "deleting";
    try {
      await repository.delete(publicId(characterId), l.userId).catch(error => denied(l, "character.delete_denied", characterId, error)); ensure(l);
      l.characters = await repository.list(l.userId); ensure(l);
    } finally { if (lobbies.get(l.playerId) === l && l.status === "deleting") { l.status = "lobby"; send(l); } }
  }
  async function select(playerId, characterId) {
    const l = lobbyOf(playerId); check(l.status === "lobby", "INVALID_STATE"); throttle(l);
    l.status = "applying"; send(l);
    let character;
    try {
      character = await repository.get(publicId(characterId)); ensure(l);
      if (!character || character.userId !== l.userId) await denied(l, "character.select_denied", characterId, new CharacterError("CHARACTER_NOT_FOUND"));
    } catch (error) {
      if (lobbies.get(l.playerId) === l && l.status === "applying") { l.status = "lobby"; send(l); }
      throw error;
    }
    try {
      l.character = character;
      await game.apply(l.player, clone(character), () => valid(l) && l.status === "applying", l.token); ensure(l);
      game.release(l.player, l); l.status = "playing";
      await repository.touch(character.characterId, l.userId); ensure(l);
      await save(l); ensure(l); send(l);
      event("ms:characterReady", { playerId: l.playerId, sessionId: l.sessionId, userId: l.userId, characterId: character.characterId });
      return summary(character);
    } catch (error) {
      // The native state may be half applied: never leave the player in the world like this.
      if (lobbies.get(l.playerId) === l) await detach(l, "Não foi possível carregar a personagem.");
      throw error;
    }
  }
  // Transient failures (DB timeout, native capture) are retried on the next tick; the player is only
  // kicked after MAX_SAVE_FAILURES in a row. A version conflict means the row changed outside this
  // session (admin edit, duplicate session): the in-memory copy is stale, so stop it at once.
  async function saveAll() {
    await Promise.all([...lobbies.values()].map(async l => {
      try { if (await save(l)) l.saveFailures = 0; }
      catch (error) {
        if (lobbies.get(l.playerId) !== l) return;
        const code = errorCode(error);
        l.saveFailures += 1;
        logger.error(`[ms-character] autosave failed: character ${l.character?.characterId} (${code}, ${l.saveFailures}/${MAX_SAVE_FAILURES})`);
        if (code === "REVISION_CONFLICT") await detach(l, "A personagem foi alterada fora do jogo. Volta a ligar.");
        else if (l.saveFailures >= MAX_SAVE_FAILURES) await detach(l, "Não foi possível guardar a personagem.");
      }
    }));
  }
  const api = Object.freeze({
    version: "0.2.0",
    isPlaying: id => { const l = lobbies.get(id); return Boolean(l && valid(l) && l.status === "playing"); },
    getSelected: id => { const l = lobbies.get(id); return l && valid(l) && l.status === "playing" ? clone(l.character) : null; },
    list: async id => { const l = lobbyOf(id); return (await repository.list(l.userId)).map(summary); },
    save: async id => save(lobbyOf(id)),
  });
  return { api, open, create, delete: remove, select, saveAll,
    guard(id) { const l = lobbies.get(id); return () => Boolean(l && lobbies.get(id) === l); },
    // Ignored (no notice) when repeated within 500 ms: each one serializes the whole state, looks included (L-02).
    sync(id) { const l = lobbyOf(id); if (clock() - (l.lastSyncAt || 0) < 500) return; l.lastSyncAt = clock(); send(l); },
    disconnect(id) { const l = lobbies.get(id); return l ? detach(l) : Promise.resolve(); },
    sessionEnded(sessionId) { for (const l of lobbies.values()) if (l.sessionId === sessionId) return detach(l); return Promise.resolve(); },
    async stop() { if (closing) return; closing = true; await Promise.all([...lobbies.values()].map(l => detach(l, "A seleção de personagens reiniciou. Volta a ligar."))); },
  };
}
module.exports = { createLobby };
