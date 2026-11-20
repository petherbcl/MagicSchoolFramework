"use strict";
const { loadConfig } = require("./config");
const { createSpawn } = require("./spawn");
const { createGameAdapter } = require("./game");
const { SpawnError } = require("./validation");
let spawn, game, ready = false;

// Resolved on every call so an "ensure ms-core" reload never leaves a stale export behind.
const coreApi = () => { try { return Exports.get("ms-core", "Core") || null; } catch { return null; } };
const Core = { Users: {
  get: id => coreApi()?.Users.get(id) ?? null,
  isReady: id => Boolean(coreApi()?.Users.isReady(id)),
} };

// Player-facing notices (pt-PT). The first group is copied from docs/design/handoff-ms-spawn.md §3.1.
const REJECTED = "O servidor rejeitou este local. Escolhe outro local e tenta de novo.";
const messages = { INVALID_LOCATION: REJECTED, LOCATION_REJECTED: REJECTED,
  NOT_ARRIVED: "Aguarda a chegada ao local antes de confirmares.",
  INVALID_STATE: "Aguarda a etapa atual.", RATE_LIMITED: "Aguarda antes de repetir.",
  // CHG-01 (decision G11, text from handoff §9.3): the server could not move the player to the selected point; the selection stays.
  MOVE_LIMIT: "Mudaste de local demasiadas vezes. Confirma o local atual.",
  TELEPORT_FAILED: "Não foi possível preparar este local. Tenta de novo ou escolhe outro local." };

// Known SpawnError codes become a notice. Anything else cancels the selection (ms-character falls back to its default
// destination): a failure here never kicks, because ms-spawn never touches the native player state.
// Notice and ingress caps live in spawn.js (per player: token bucket on every client event, one notice per code per 2 s).
let watchdog = null;
function safe(player, fn) {
  const same = spawn?.guard(player.id) || (() => false);
  Promise.resolve().then(() => { if (same()) return fn(); }).catch(error => {
    if (!same()) return;
    if (error instanceof SpawnError) {
      const text = messages[error.code];
      if (text) spawn.notify(player.id, text, error.code);
      return;
    }
    console.error("[ms-spawn] operation failed: " + (error.code || error.name));
    spawn.abort(player.id, "INTERNAL_ERROR");
  });
}
// Only `id` is ever read from a client payload, and only when it is a short string.
const clientId = input => input && typeof input === "object" && typeof input.id === "string" && input.id.length <= 64;

// Teleport results of the server-initiated moves; ids that are not ms-spawn's own (ms-character's teleports) are ignored.
Events.on("playerTeleportComplete", (player, requestId, status) => { if (game && player) game.complete(player.id, requestId, status); });
Events.on("ms:spawnSelectionRequested", payload => { if (spawn) spawn.request(payload); });
Events.on("ms:characterReady", payload => { if (spawn) spawn.characterReady(payload); });
Events.on("ms:sessionEnded", ({ sessionId } = {}) => { if (spawn) spawn.sessionEnded(sessionId); });
Events.on("playerDisconnect", player => { if (spawn) spawn.disconnect(player.id); });
Events.onClient("ms-spawn:select", (player, input) => { if (ready && clientId(input)) safe(player, () => spawn.select(player.id, input)); });
Events.onClient("ms-spawn:arrived", (player, input) => { if (ready && clientId(input)) safe(player, () => spawn.arrived(player.id, input)); });
Events.onClient("ms-spawn:opened", player => { if (ready) safe(player, () => spawn.opened(player.id)); });
Events.onClient("ms-spawn:abandon", player => { if (ready) safe(player, () => spawn.abandon(player.id)); });
Events.onClient("ms-spawn:confirm", (player, input) => { if (ready && clientId(input)) safe(player, () => spawn.confirm(player.id, input)); });
Events.on("resourceStart", name => {
  if (name !== "ms-spawn") return;
  // Fail closed: an invalid configuration stops the resource (no export), and ms-character keeps its default spawn.
  let config;
  try { config = loadConfig(); }
  catch (error) { console.error("[ms-spawn] invalid configuration, spawn selection disabled: " + (error.code || error.name)); throw new Error("MS_SPAWN_STARTUP_FAILED"); }
  if (typeof coreApi()?.Users?.isReady !== "function") { console.error("[ms-spawn] the ms-core export is unavailable"); throw new Error("MS_SPAWN_STARTUP_FAILED"); }
  game = createGameAdapter({ getPlayer: id => PlayerManager.getById(id) });
  spawn = createSpawn({ config, game, core: Core, emit: (event, payload) => Events.emit(event, payload), notices: { TELEPORT_FAILED: messages.TELEPORT_FAILED } });
  if (!Exports.register("Spawn", spawn.api)) { spawn = null; throw new Error("MS_SPAWN_STARTUP_FAILED"); }
  spawn.start(); ready = true;
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => { try { spawn.tick(); } catch { console.error("[ms-spawn] watchdog failed"); } }, 5000);
  if (typeof watchdog?.unref === "function") watchdog.unref();
  console.log(`[ms-spawn] ms-spawn ready (${config.locations.length} locations)`);
});
Events.on("resourceStop", name => {
  if (name !== "ms-spawn") return;
  ready = false;
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (spawn) spawn.stop();
});
