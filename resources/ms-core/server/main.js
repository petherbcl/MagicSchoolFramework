"use strict";
const { loadConfig } = require("./config");
const { Repository } = require("./database/repository");
const { createCore } = require("./core");
const { createGameAdapter } = require("./game");
const { CoreError } = require("./validation");
const { createSemaphore } = require("./semaphore");
let core, repository, game, config, tickTimer, ready = false;
const calls = new Map();
const STARTUP_DB_WAIT_MS = 10000;
// ms-sql owns the connection. Resolved lazily on every use so an `ensure ms-sql` reload never leaves a stale export.
function sqlApi() { try { return Exports.get("ms-sql", "Sql") || null; } catch { return null; } }
// Admissions are open only while the core is started and the database is reachable.
const open = () => ready && sqlApi()?.isReady() === true;
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
  SESSION_LIMIT: "O servidor está cheio. Tenta novamente mais tarde.", CORE_STOPPING: "A framework está a reiniciar. Tenta novamente.",
  QUEUE_FULL: "O servidor está com muitas ligações. Tenta novamente dentro de instantes.", TASK_TIMEOUT: "A verificação do registo demorou demasiado. Tenta novamente." };
// SEC-03 / R-02: handshakes go through a bounded FIFO semaphore so a burst can not hold every pooled ms-sql
// connection at once and starve tick(). Abandoned connections are dropped before they run, a stuck job frees its
// slot after a timeout, and a full queue refuses explicitly.
let admissions, lastQueueFullLog = 0;
const admissionLimits = () => { admissions ||= createSemaphore({ limit: config.admission.concurrency, maxQueue: config.admission.maxQueue,
  taskTimeoutMs: config.admission.taskTimeoutMs }); return admissions; };
function logAdmissionFailure(error) {
  if (error instanceof CoreError || error.code === "ABANDONED") return;
  if (error.code === "QUEUE_FULL") { const now = Date.now(); if (now - lastQueueFullLog < 10000) return; lastQueueFullLog = now; }
  console.error("[ms-core] admission failed: " + (error.code || error.name));
}
// The handshake waits for the returned promise: the result is shown on the joining screen.
Events.on("playerConnecting", connection => {
  if (!open()) { connection.reject("Framework indisponível: verifica a base de dados."); return; }
  connection.update("A verificar o registo...");
  return admissionLimits().run(() => { if (!open()) throw new CoreError("CORE_STOPPING"); return core.admit(connection); },
    { isAbandoned: () => !connection.isPending() }).then(result => {
    if (!connection.isPending()) return;
    if (result.allowed) connection.update(result.message); else connection.reject(result.message);
  }, error => {
    logAdmissionFailure(error);
    if (connection.isPending()) connection.reject(admissionErrors[error.code] || "Não foi possível verificar o registo. Tenta novamente.");
  });
});
Events.on("playerConnect", player => {
  if (!open()) { player.kick("Framework indisponível."); return; }
  player.setSpawn(config.spawn);
  // attach establishes the private world synchronously before its first query.
  core.attach(player).catch(error => console.error("[ms-core] session start failed: " + (error.code || error.name)));
});
Events.on("loadingFinished", player => { if (open() && core.api.Users.get(player.id)) safe(player, () => core.loaded(player.id)); });
Events.on("playerDisconnect", player => {
  calls.delete(player.id); if (core) core.disconnect(player.id).catch(() => console.error("[ms-core] disconnect persistence failed"));
});
Events.onClient("ms-core:sync", player => {
  if (!open() || !core.api.Users.get(player.id)) return;
  const now = Date.now(); if (now - (calls.get(player.id) || 0) < 1000) return;
  calls.set(player.id, now); safe(player, () => core.sync(player.id));
});
Events.onClient("ms-core:register", (player, input) => { if (open()) safe(player, () => core.register(player.id, input)); });
Events.onClient("ms-core:credentialStored", (player, input) => { if (open()) safe(player, () => core.credentialStored(player.id, input)); });
Events.on("chatCommand", (player, message, command) => { if (open() && ["id", "registo"].includes(command)) safe(player, () => core.sync(player.id)); });
Events.on("resourceStart", async name => {
  if (name !== "ms-core") return;
  config = loadConfig();
  try {
    if (!sqlApi()) { console.error("[ms-core] the ms-sql export is unavailable (is ms-sql started?); admissions remain closed"); return; }
    try { await sqlApi().awaitConnection(STARTUP_DB_WAIT_MS); }
    catch (error) {
      if (error?.kind !== "NOT_READY") throw error;
      console.error("[ms-core] ms-sql has no database configured (set MS_SQL_URL in resources/ms-sql/.env); admissions remain closed"); return;
    }
    repository = new Repository(sqlApi); await repository.createTables(); await repository.endAbandonedSessions(config.serverKey);
    game = createGameAdapter(config); core = createCore({ repository, config, game, databaseReady: () => sqlApi()?.isReady() === true, emit: (event, payload) => Events.emit(event, payload) });
    if (!Exports.register("Core", core.api)) throw new Error("EXPORT_REGISTRATION_FAILED");
    admissions = null; ready = true;
    tickTimer = setInterval(() => core.tick().catch(() => console.error("[ms-core] access polling failed")), config.accessPollMs);
    for (const player of PlayerManager.getAll()) core.attach(player, Boolean(player.location()))
      .catch(error => console.error("[ms-core] session start failed: " + (error.code || error.name)));
    console.log("[ms-core] database ready (" + sqlApi().dialect + "); numeric registration IDs and external allowlist enabled");
  } catch (error) {
    ready = false; if (core) await core.stop();
    console.error("[ms-core] startup failed: " + (error.code || error.name)); throw new Error("MS_CORE_STARTUP_FAILED");
  }
});
Events.on("resourceStop", async name => {
  if (name !== "ms-core") return;
  ready = false; if (tickTimer) clearInterval(tickTimer);
  if (core) await core.stop();
});
