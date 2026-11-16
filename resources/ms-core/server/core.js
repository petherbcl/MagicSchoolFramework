"use strict";
const crypto = require("node:crypto");
const { check, clone, metadata, observed, CoreError, publicId } = require("./validation");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function createCore({ repository, config, game, emit = () => {}, logger = console, clock = Date.now }) {
  const sessions = new Map(), accounts = new Map(), closingTasks = new Set();
  let closing = false, worldSequence = 0, checking = false;
  const current = s => !closing && sessions.get(s.playerId) === s;
  const ensure = s => check(current(s), "SESSION_EXPIRED");
  const session = id => { const s = sessions.get(id); check(s && current(s), "SESSION_EXPIRED"); return s; };
  const permitted = (user, permission) => user.roles.some(role => (config.rolePermissions[role] || []).some(grant => grant === "*" || grant === permission));
  const event = (name, value) => {
    try { Promise.resolve(emit(name, clone(value))).catch(() => logger.error("[ms-core] event handler failed: " + name)); }
    catch { logger.error("[ms-core] event handler failed: " + name); }
  };
  const snapshot = s => ({ sessionId: s.sessionId, playerId: s.playerId, userId: s.userId,
    characterId: s.character?.characterId || null, status: s.status, authenticated: s.authenticated,
    allowlist: s.user?.allowlist || null, roles: s.user?.roles || [], metadata: s.user?.metadata || {},
    identifiers: { observed: s.observed }, credentialConfirmed: s.credentialConfirmed });
  function formUrl(userId) {
    if (!config.formUrl || !userId) return "";
    const url = new URL(config.formUrl); url.searchParams.set("id", userId); return url.href;
  }
  function send(s) {
    if (!current(s)) return;
    game.send(s.player, "ms-core:session", { sessionId: s.sessionId, status: s.status, serverKey: config.serverKey,
      userId: s.userId, allowlist: s.user?.allowlist || null, formUrl: formUrl(s.userId),
      characters: s.characters.map(({ characterId, firstName, lastName, house }) => ({ characterId, firstName, lastName, house })),
      maxCharacters: config.maxCharacters });
    if (s.status === "awaitingCredentialStorage" && s.newCredential) {
      game.send(s.player, "ms-core:credential", { sessionId: s.sessionId, serverKey: config.serverKey, credential: s.newCredential });
    }
  }
  async function access(s) {
    ensure(s); check(s.authenticated && s.credentialConfirmed && s.userId, "NOT_AUTHENTICATED");
    const [user, ban, valid] = await Promise.all([repository.getUser(s.userId), repository.activeBan(s.userId), repository.verifyCredential(s.credentialHash, s.userId)]);
    check(valid, "INVALID_CREDENTIAL");
    ensure(s); check(user && user.allowlist === "approved", "ALLOWLIST_REQUIRED"); check(!ban, "ACCOUNT_BANNED");
    s.user = user; return user;
  }
  function save(s) {
    if (s.status !== "ready" || !s.character) return Promise.resolve(false);
    // Take the snapshot synchronously while a disconnect handle is still valid.
    let state;
    try { state = game.capture(s.player, clone(s.character.state)); }
    catch (error) { return Promise.reject(error); }
    const task = s.saveChain.catch(() => {}).then(async () => {
      s.character = await repository.saveCharacter(s.character.characterId, s.userId, s.character.version, state);
      return true;
    });
    s.saveChain = task; return task;
  }
  function detach(s, reason, kickMessage) {
    if (sessions.get(s.playerId) !== s) return Promise.resolve();
    const saving = save(s);
    s.status = "closed"; s.newCredential = null;
    sessions.delete(s.playerId);
    if (accounts.get(s.userId) === s) accounts.delete(s.userId);
    try { game.cancel(s); } catch { logger.error("[ms-core] native cleanup failed"); }
    if (kickMessage) game.kick(s.player, kickMessage);
    const task = saving.catch(() => logger.error("[ms-core] character save failed during disconnect"))
      .then(async () => {
        const id = await s.persisting;
        if (id !== null) {
          await repository.endSession(id, reason);
          event("ms:sessionEnded", { sessionId: id, userId: s.userId, reason });
        }
      }).catch(() => logger.error("[ms-core] session close failed"));
    closingTasks.add(task); task.finally(() => closingTasks.delete(task)); return task;
  }
  async function attach(player, loaded = false) {
    check(!closing, "CORE_STOPPING");
    if (sessions.has(player.id)) await detach(sessions.get(player.id), "replaced");
    check(!closing && sessions.size < config.maxSessions, "SESSION_LIMIT");
    const s = { sessionId: null, persisting: Promise.resolve(null), playerId: player.id, player, observed: observed(player),
      userId: null, user: null, authenticated: false, credentialConfirmed: false, newCredential: null,
      status: "connecting", loaded, characters: [], character: null, saveChain: Promise.resolve(),
      world: config.quarantineWorldBase + (++worldSequence), expiresAt: clock() + config.approvalTimeoutMs,
      lastActionAt: 0, registration: null };
    sessions.set(player.id, s);
    try {
      game.restrict(player, s);
      s.persisting = repository.startSession(player.id, config.serverKey);
      s.sessionId = await s.persisting;
      if (!current(s)) throw new CoreError("SESSION_EXPIRED");
      s.status = "identifying"; send(s);
      event("ms:sessionStarted", { sessionId: s.sessionId, playerId: s.playerId });
      return clone(snapshot(s));
    } catch (error) { if (current(s)) await detach(s, "registrationFailed", "Não foi possível preparar o registo."); throw error; }
  }
  async function evaluate(s) {
    ensure(s);
    const [user, ban, valid] = await Promise.all([repository.getUser(s.userId), repository.activeBan(s.userId), repository.verifyCredential(s.credentialHash, s.userId)]);
    check(valid, "INVALID_CREDENTIAL");
    ensure(s); check(user, "USER_NOT_FOUND"); s.user = user;
    if (ban || user.allowlist === "denied") {
      await detach(s, ban ? "banned" : "allowlistDenied", ban ? "Conta bloqueada: " + ban.reason : "O teu pedido de allowlist foi recusado."); return;
    }
    if (user.allowlist !== "approved") {
      if (s.status === "ready" || s.status === "applyingCharacter" || s.status === "waitingForWorld") {
        await detach(s, "accessRevoked", "O acesso à conta foi alterado."); return;
      }
      s.status = "awaitingApproval"; send(s); return;
    }
    if (s.status === "awaitingApproval" || s.status === "checkingAccess") {
      s.characters = await repository.listCharacters(s.userId); ensure(s);
      s.status = "selectingCharacter"; s.expiresAt = clock() + config.approvalTimeoutMs; send(s);
      event("ms:userAuthenticated", snapshot(s));
    }
  }
  function register(playerId, input) {
    const s = session(playerId);
    check(input && input.sessionId === s.sessionId, "SESSION_EXPIRED");
    if (s.registration) return s.registration;
    check(s.status === "identifying", "INVALID_SESSION_STATE");
    let credential = input.credential;
    check(credential === null || (typeof credential === "string" && /^[A-Za-z0-9_-]{43}$/.test(credential)), "INVALID_CREDENTIAL");
    s.status = "registering";
    s.registration = (async () => {
      try {
        const issue = () => crypto.randomBytes(32).toString("base64url");
        let fresh = credential === null ? issue() : null, user;
        try { user = await repository.register(credential ? hash(credential) : null, fresh ? hash(fresh) : null, s.observed); }
        catch (error) {
          if (error.code !== "UNKNOWN_CREDENTIAL") throw error;
          // The stored key belongs to no account: register as a new client; the issued key replaces it.
          ensure(s); credential = null; fresh = issue();
          user = await repository.register(null, hash(fresh), s.observed);
        }
        ensure(s);
        check(!accounts.has(user.userId), "ACCOUNT_ALREADY_ONLINE");
        // Reserve before another asynchronous bind can admit the same account.
        s.userId = user.userId; s.user = user; s.credentialHash = hash(credential || fresh); accounts.set(user.userId, s);
        await repository.bindSession(s.sessionId, user.userId); ensure(s);
        s.authenticated = true;
        if (fresh) { s.newCredential = fresh; s.status = "awaitingCredentialStorage"; send(s); }
        else { s.credentialConfirmed = true; s.status = "checkingAccess"; await evaluate(s); }
        return clone(snapshot(s));
      } catch (error) {
        const message = error.code === "IDENTIFIER_ALREADY_REGISTERED" ? "Os teus identificadores já estão associados a uma conta. Usa a chave local original ou contacta a equipa para recuperar o acesso." :
          error.code === "IDENTIFIER_REQUIRED" ? "Não foi possível obter um identificador para o registo. Contacta a equipa." :
          error.code === "INVALID_CREDENTIAL" ? "A chave local deixou de ser válida. Contacta a equipa para recuperar a conta." : "Não foi possível identificar a conta.";
        if (current(s)) await detach(s, "identificationFailed", message);
        throw error;
      }
    })();
    return s.registration;
  }
  async function credentialStored(playerId, input) {
    const s = session(playerId);
    check(input && input.sessionId === s.sessionId, "SESSION_EXPIRED");
    if (s.credentialConfirmed) return; // Native/UI resynchronization may repeat the acknowledgement.
    check(s.status === "awaitingCredentialStorage", "INVALID_SESSION_STATE");
    s.newCredential = null; s.credentialConfirmed = true; s.status = "checkingAccess";
    try { await evaluate(s); }
    catch (error) { if (current(s)) await detach(s, "accessCheckFailed", "Não foi possível verificar o acesso."); throw error; }
  }
  async function hasPermission(id, permission) {
    const s = sessions.get(id); if (!s || s.status !== "ready") return false;
    try { return permitted(await access(s), permission); } catch { return false; }
  }
  async function actor(id, permission) {
    const s = session(id);
    check(await hasPermission(id, permission), "FORBIDDEN"); ensure(s); return "user:" + s.userId;
  }
  async function createCharacter(id, value) {
    const s = session(id); check(s.status === "selectingCharacter", "INVALID_SESSION_STATE");
    check(clock() - s.lastActionAt >= 750, "RATE_LIMITED"); s.lastActionAt = clock();
    check(permitted(await access(s), "characters.create"), "FORBIDDEN"); ensure(s);
    const character = await repository.createCharacter(s.userId, value, config.maxCharacters); ensure(s);
    s.characters = await repository.listCharacters(s.userId); ensure(s); send(s); return clone(character);
  }
  async function apply(s) {
    if (!current(s) || s.status !== "waitingForWorld" || !s.loaded) return;
    s.status = "applyingCharacter";
    try {
      await access(s);
      await game.apply(s.player, clone(s.character), () => current(s) && s.status === "applyingCharacter", s.sessionId);
      ensure(s); await access(s);
      game.release(s.player, s); s.status = "ready";
      await save(s); ensure(s); send(s);
      event("ms:playerReady", { playerId: s.playerId, sessionId: s.sessionId, userId: s.userId, characterId: s.character.characterId });
    } catch (error) { if (current(s)) await detach(s, "characterApplyFailed", "Não foi possível carregar a personagem."); throw error; }
  }
  async function selectCharacter(id, characterId) {
    const s = session(id); check(s.status === "selectingCharacter", "INVALID_SESSION_STATE");
    s.status = "selecting";
    try {
      check(permitted(await access(s), "characters.select"), "FORBIDDEN");
      const character = await repository.getCharacter(publicId(characterId)); ensure(s);
      check(character && character.userId === s.userId, "CHARACTER_NOT_FOUND");
      s.character = character; s.status = "waitingForWorld"; send(s);
      if (s.loaded) await apply(s);
      return { characterId: character.characterId, status: s.status };
    } catch (error) { if (current(s) && s.status === "selecting") { s.status = "selectingCharacter"; send(s); } throw error; }
  }
  async function loaded(id) {
    const s = session(id); s.loaded = true;
    if (s.status === "waitingForWorld") await apply(s);
    else if (s.status !== "ready") { game.restrict(s.player, s); send(s); }
  }
  async function tick() {
    if (checking || closing) return; checking = true;
    try {
      for (const s of [...sessions.values()]) {
        if (!current(s)) continue;
        if (s.status !== "ready" && s.expiresAt <= clock()) { await detach(s, "timeout", "O tempo de espera terminou. Volta a ligar com o mesmo cliente."); continue; }
        if (s.userId && s.credentialConfirmed && !["checkingAccess", "registering", "selecting"].includes(s.status)) {
          try { await evaluate(s); }
          catch { if (current(s)) await detach(s, "databaseUnavailable", "A base de dados está indisponível."); }
        }
      }
    } finally { checking = false; }
  }
  const api = Object.freeze({
    version: "0.2.0",
    Users: Object.freeze({
      get: id => sessions.has(id) ? clone(snapshot(sessions.get(id))) : null,
      getOnlineById: id => accounts.has(String(id)) ? clone(snapshot(accounts.get(String(id)))) : null,
      isReady: id => sessions.get(id)?.status === "ready", hasPermission,
      load: async (id, source) => { await actor(source, "users.read"); return clone(await repository.getUser(publicId(id))); },
      setMetadata: async (id, key, value, source) => {
        id = publicId(id); const s = session(source);
        const self = s.userId === id && await hasPermission(source, "users.metadata.self");
        const author = self ? "user:" + s.userId : await actor(source, "users.metadata.write"); ensure(s);
        const user = await repository.setMetadata(id, key, metadata(key, value), author);
        if (accounts.has(id)) accounts.get(id).user = user; return clone(user.metadata);
      },
      save: async id => save(session(id)),
    }),
    Allowlist: Object.freeze({
      approve: async (id, source) => { const result = await repository.setAllowlist(publicId(id), "approved", await actor(source, "allowlist.manage")); await tick(); return clone(result); },
      deny: async (id, reason, source) => { const result = await repository.setAllowlist(publicId(id), "denied", await actor(source, "allowlist.manage"), reason); await tick(); return clone(result); },
    }),
    Roles: Object.freeze({ set: async (id, role, enabled, source) => {
      const author = await actor(source, "roles.manage"); check(Object.hasOwn(config.rolePermissions, role) && typeof enabled === "boolean", "INVALID_ROLE");
      const result = await repository.setRole(publicId(id), role, enabled, author); await tick(); return clone(result);
    } }),
    Bans: Object.freeze({
      add: async (id, reason, expiresAt, source) => { const value = await repository.ban(publicId(id), reason, expiresAt, await actor(source, "bans.manage")); await tick(); return value; },
      revoke: async (id, source) => repository.unban(publicId(id), await actor(source, "bans.manage")),
    }),
    Characters: Object.freeze({
      list: async id => { const s = session(id); await access(s); return clone((await repository.listCharacters(s.userId)).map(({ state, ...row }) => row)); },
      getSelected: id => sessions.get(id)?.character ? clone(sessions.get(id).character) : null,
      create: createCharacter, select: selectCharacter, save: async id => save(session(id)),
    }),
  });
  return { api, attach, register, credentialStored, loaded, tick,
    guard(id) { const s = sessions.get(id); return () => Boolean(s && current(s)); },
    sync(id) { send(session(id)); },
    disconnect(id) { const s = sessions.get(id); return s ? detach(s, "disconnect") : Promise.resolve(); },
    async saveAll() { await Promise.all([...sessions.values()].map(async s => {
      try { await save(s); } catch { if (current(s)) await detach(s, "saveFailed", "Não foi possível guardar os dados."); }
    })); },
    async stop() { if (closing) return; closing = true; await Promise.all([...sessions.values()].map(s => detach(s, "resourceStop", "A framework reiniciou. Volta a ligar."))); await Promise.all([...closingTasks]); },
  };
}
module.exports = { createCore };
