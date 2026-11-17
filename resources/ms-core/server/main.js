"use strict";
const { loadConfig } = require("./config");
const { Repository } = require("./database/repository");
const { createCore } = require("./core");
const { createGameAdapter } = require("./game");
const { CoreError } = require("./validation");
let core, repository, game, config, tickTimer, ready = false;
const calls = new Map();
const messages = { NOT_AUTHENTICATED: "Aguarda a identificação da tua conta.", INVALID_SESSION_STATE: "Aguarda a etapa atual.",
  RATE_LIMITED: "Aguarda antes de repetir.", FORBIDDEN: "Não tens permissão.", INVALID_ID: "ID inválido." };
function safe(player, fn) {
  const same = core?.guard(player.id) || (() => false);
  Promise.resolve().then(() => { if (same()) return fn(); }).catch(error => {
    if (!same()) return;
    if (error instanceof CoreError) player.emit("ms-core:notice", JSON.stringify({ text: messages[error.code] || "Não foi possível concluir a operação." }));
    else { console.error("[ms-core] operation failed: " + (error.code || error.name)); player.kick("Erro da framework. Tenta novamente."); }
  });
}
const admissionErrors = { IDENTIFIER_REQUIRED: "Não foi possível obter um identificador Steam, Epic, Discord ou de hardware. Contacta a equipa.",
  IDENTIFIER_CONFLICT: "Os teus identificadores estão associados a mais do que um registo. Contacta a equipa.",
  SESSION_LIMIT: "O servidor está cheio. Tenta novamente mais tarde.", CORE_STOPPING: "A framework está a reiniciar. Tenta novamente." };
// The handshake waits for the returned promise: the result is shown on the joining screen.
Events.on("playerConnecting", connection => {
  if (!ready) { connection.reject("Framework indisponível: verifica a configuração PostgreSQL."); return; }
  connection.update("A verificar o registo...");
  return core.admit(connection).then(result => {
    if (!connection.isPending()) return;
    if (result.allowed) connection.update(result.message); else connection.reject(result.message);
  }, error => {
    if (!(error instanceof CoreError)) console.error("[ms-core] admission failed: " + (error.code || error.name));
    if (connection.isPending()) connection.reject(admissionErrors[error.code] || "Não foi possível verificar o registo. Tenta novamente.");
  });
});
Events.on("playerConnect", player => {
  if (!ready) { player.kick("Framework indisponível."); return; }
  player.setSpawn(config.spawn);
  // attach establishes the private world synchronously before its first query.
  core.attach(player).catch(error => console.error("[ms-core] session start failed: " + (error.code || error.name)));
});
Events.on("loadingFinished", player => { if (ready && core.api.Users.get(player.id)) safe(player, () => core.loaded(player.id)); });
Events.on("playerDisconnect", player => {
  calls.delete(player.id); if (core) core.disconnect(player.id).catch(() => console.error("[ms-core] disconnect persistence failed"));
});
Events.onClient("ms-core:sync", player => {
  if (!ready || !core.api.Users.get(player.id)) return;
  const now = Date.now(); if (now - (calls.get(player.id) || 0) < 1000) return;
  calls.set(player.id, now); safe(player, () => core.sync(player.id));
});
Events.onClient("ms-core:register", (player, input) => { if (ready) safe(player, () => core.register(player.id, input)); });
Events.onClient("ms-core:credentialStored", (player, input) => { if (ready) safe(player, () => core.credentialStored(player.id, input)); });
Events.on("chatCommand", (player, message, command) => { if (ready && ["id", "registo"].includes(command)) safe(player, () => core.sync(player.id)); });
Events.on("resourceStart", async name => {
  if (name !== "ms-core") return;
  config = loadConfig();
  if (!config.databaseConfigured) { console.error("[ms-core] set MS_DATABASE_URL in resources/ms-core/.env or the process environment; admissions remain closed"); return; }
  try {
    repository = new Repository(config); await repository.createSchema(); await repository.endAbandonedSessions(config.serverKey);
    game = createGameAdapter(config); core = createCore({ repository, config, game, emit: (event, payload) => Events.emit(event, payload) });
    if (!Exports.register("Core", core.api)) throw new Error("EXPORT_REGISTRATION_FAILED");
    ready = true;
    tickTimer = setInterval(() => core.tick().catch(() => console.error("[ms-core] access polling failed")), config.accessPollMs);
    for (const player of PlayerManager.getAll()) core.attach(player, Boolean(player.location()))
      .catch(error => console.error("[ms-core] session start failed: " + (error.code || error.name)));
    console.log("[ms-core] PostgreSQL ready; numeric registration IDs and external allowlist enabled");
  } catch (error) {
    ready = false; if (core) await core.stop(); if (repository) await repository.close();
    console.error("[ms-core] startup failed: " + (error.code || error.name)); throw new Error("MS_CORE_POSTGRESQL_STARTUP_FAILED");
  }
});
Events.on("resourceStop", async name => {
  if (name !== "ms-core") return;
  ready = false; if (tickTimer) clearInterval(tickTimer);
  if (core) await core.stop(); if (repository) await repository.close();
});
