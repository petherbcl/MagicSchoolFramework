"use strict";
const { check, clone, publicId, CharacterError } = require("./validation");
const MAX_SAVE_FAILURES = 3;
const COORDINATE_BOUND = 1e7;     // centimetres, same bound as ms-spawn's configuration (SEC-05)
const SPAWN_WATCH_GRACE_MS = 5000; // a request younger than this is never judged lost (the answer may still be in flight)
const errorCode = error => error?.code || error?.name || "UNKNOWN";

// Character lobby state machine. Dependencies are injected so tests replace them:
// repository (PostgreSQL), game (native adapter), core (ms-core's Core export), emit (server events).
// Lifecycle per player: loading → lobby ⇄ creating | deleting → applying → playing → (closed)
// With ms-spawn ready, selecting a character inserts choosingSpawn before applying: the player is held while ms-spawn
// answers (ms:spawnSelected / ms:spawnCancelled). `spawn.isReady()` is the lazy availability probe (default: absent).
function createLobby({ repository, config, game, core, spawn = { isReady: () => false }, emit = () => {}, logger = console, clock = Date.now }) {
  const lobbies = new Map();
  let closing = false, worldSequence = 0, tokenSequence = 0;
  // Native playerIds are reused and ms-core sessions can end mid-operation: re-check after every await.
  const valid = l => !closing && lobbies.get(l.playerId) === l &&
    core.Users.get(l.playerId)?.sessionId === l.sessionId && core.Users.isReady(l.playerId);
  const ensure = l => check(valid(l), "SESSION_EXPIRED");
  const lobbyOf = id => { const l = lobbies.get(id); check(l && valid(l), "SESSION_EXPIRED"); return l; };
  // Last position offered to ms-spawn: Overland only, with finite numbers (a missing yaw counts as 0, like game.apply).
  const lastPosition = character => {
    const at = character.state?.location;
    if (at?.areaId !== "Overland") return null;
    const yaw = at.yaw === undefined ? 0 : at.yaw;
    return [at.x, at.y, at.z, yaw].every(Number.isFinite) ? { x: at.x, y: at.y, z: at.z, yaw } : null;
  };
  // CHG-04: the character's roles for ms-spawn: always a fresh array, at most 32 entries of 1..32 characters (non-strings, empty and
  // longer entries are dropped, never cut, so a cut role can never match another one).
  const spawnRoles = value => (Array.isArray(value) ? value : []).filter(item => typeof item === "string" && item.length >= 1 && item.length <= 32).slice(0, 32);
  const destinationOf = value => {
    const at = value?.destination;
    return at && [at.x, at.y, at.z].every(n => Number.isFinite(n) && Math.abs(n) <= COORDINATE_BOUND) && Number.isFinite(at.yaw) && Math.abs(at.yaw) <= 360 ? { x: at.x, y: at.y, z: at.z, yaw: at.yaw } : null;
  };
  const probe = () => { try { return spawn.isReady() === true; } catch { return false; } };
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
      maxCharacters: config.maxCharacters, characterId: l.character?.characterId || null,
      groundSnapped: l.groundSnapped === true });
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
      const roles = l.character.roles || []; // the save returns the row only: the roles stay in memory
      l.character = { ...(await repository.save(l.character.characterId, l.userId, l.character.version, state)), roles };
      return true;
    });
    l.saveChain = task; return task;
  }
  function detach(l, kickMessage) {
    if (lobbies.get(l.playerId) !== l) return Promise.resolve();
    const saving = save(l);
    l.status = "closed"; lobbies.delete(l.playerId);
    if (l.spawnWait) { const { reject } = l.spawnWait; l.spawnWait = null; reject(new CharacterError("SESSION_EXPIRED")); }
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
      // The characters load while the game confirms the ground under the lobby spawn; the lobby opens when both are done.
      const [characters, groundSnapped] = await Promise.all([repository.list(userId), game.settleLobby(player, l)]); ensure(l);
      l.characters = characters; l.groundSnapped = groundSnapped === true;
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
      // Old characters get the role of their house too; the roles stay in memory with the selected character.
      character.roles = await repository.ensureHouseRole(character.characterId, character.house); ensure(l);
    } catch (error) {
      if (lobbies.get(l.playerId) === l && l.status === "applying") { l.status = "lobby"; send(l); }
      throw error;
    }
    try {
      l.character = character;
      // ms-spawn ready: hold the player in the lobby until it answers. There is no timeout for an idle player (the choice
      // is theirs); a lost ms-spawn (stopped, reloaded, client never opened its page) is released by watchSpawn / ms-spawn's own watchdog.
      let destination;
      if (probe()) {
        const answer = new Promise((resolve, reject) => { l.spawnWait = { resolve, reject }; });
        // detach() may reject this before anything awaits it (send throwing below): never an unhandled rejection (SEC-02).
        answer.catch(() => {});
        l.spawnAskedAt = clock();
        l.status = "choosingSpawn"; send(l);
        // The wait exists before the event goes out: a synchronous ms:spawnCancelled must find it.
        event("ms:spawnSelectionRequested", { playerId: l.playerId, sessionId: l.sessionId, userId: l.userId, characterId: character.characterId, last: lastPosition(character), roles: spawnRoles(character.roles) });
        destination = await answer; ensure(l);
        l.status = "applying"; send(l);
      }
      await game.apply(l.player, clone(character), () => valid(l) && l.status === "applying", l.token, destination || undefined); ensure(l);
      game.release(l.player, l); l.status = "playing";
      await repository.touch(character.characterId, l.userId); ensure(l);
      await save(l); ensure(l); send(l);
      // Tell ms-core the player enters the game with this character: it re-checks the account and keeps the player in memory.
      await core.Players.enterGame(l.playerId, { sessionId: l.sessionId, characterId: character.characterId }); ensure(l);
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
  // Liveness of ms-spawn for players held in choosingSpawn (SEC-03). Runs on the autosave tick. Releases a player with the
  // default destination when ms-spawn is gone (probe false) or no longer holds the selection (reload without the cancel event).
  function watchSpawn() {
    for (const l of [...lobbies.values()]) {
      if (l.status !== "choosingSpawn" || !l.spawnWait || !valid(l) || clock() - (l.spawnAskedAt || 0) < SPAWN_WATCH_GRACE_MS) continue;
      let holds = true;
      try { holds = typeof spawn.holds === "function" ? spawn.holds(l.playerId, l.sessionId) !== false : true; } catch { holds = false; }
      if (probe() && holds) continue;
      logger.error("[ms-character] ms-spawn no longer holds the selection, using the default spawn");
      const { resolve } = l.spawnWait; l.spawnWait = null; resolve(null);
    }
  }
  async function saveAll() {
    watchSpawn();
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
  function answerSpawn(payload, resolveWith) {
    const l = payload && Number.isInteger(payload.playerId) ? lobbies.get(payload.playerId) : null;
    if (!l || l.sessionId !== payload.sessionId || l.status !== "choosingSpawn" || !l.spawnWait || !valid(l)) return false;
    const { resolve } = l.spawnWait; l.spawnWait = null;
    const destination = resolveWith(payload);
    // A selected answer without a usable destination falls back to the default instead of leaving the player stuck.
    if (destination === null && payload.destination !== undefined) logger.error("[ms-character] ms:spawnSelected without a usable destination, using the default");
    resolve(destination);
    return true;
  }
  const api = Object.freeze({
    version: "0.6.1",
    isPlaying: id => { const l = lobbies.get(id); return Boolean(l && valid(l) && l.status === "playing"); },
    getSelected: id => { const l = lobbies.get(id); return l && valid(l) && l.status === "playing" ? clone(l.character) : null; },
    list: async id => { const l = lobbyOf(id); return (await repository.list(l.userId)).map(summary); },
    save: async id => save(lobbyOf(id)),
  });
  return { api, open, create, delete: remove, select, saveAll, watchSpawn,
    guard(id) { const l = lobbies.get(id); return () => Boolean(l && lobbies.get(id) === l); },
    // Ignored (no notice) when repeated within 500 ms: each one serializes the whole state, looks included (L-02).
    sync(id) { const l = lobbyOf(id); if (clock() - (l.lastSyncAt || 0) < 500) return; l.lastSyncAt = clock(); send(l); },
    // Answers of ms-spawn. Ignored unless playerId + sessionId + status === "choosingSpawn" still match (stale or spoofed).
    spawnSelected(payload) { return answerSpawn(payload, value => destinationOf(value)); },
    spawnCancelled(payload) { return answerSpawn(payload, () => null); },
    disconnect(id) { const l = lobbies.get(id); return l ? detach(l) : Promise.resolve(); },
    sessionEnded(sessionId) { for (const l of lobbies.values()) if (l.sessionId === sessionId) return detach(l); return Promise.resolve(); },
    async stop() { if (closing) return; closing = true; await Promise.all([...lobbies.values()].map(l => detach(l, "A seleção de personagens reiniciou. Volta a ligar."))); },
  };
}
module.exports = { createLobby };
