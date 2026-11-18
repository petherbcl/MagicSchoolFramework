"use strict";
const byId = id => document.getElementById(id);
const send = (name, payload) => { if (typeof window.callEvent === "function") window.callEvent(name, JSON.stringify(payload)); };
const storageKey = serverKey => "ms-core:credential:" + serverKey;
const registrationSent = new Set();
window.addEventListener("session", event => {
  const state = event.detail;
  if (!state || typeof state.status !== "string") return;
  byId("notice").textContent = "";
  byId("registration").hidden = !state.userId || state.status !== "awaitingApproval";
  byId("heading").textContent = state.status === "awaitingApproval" ? "O teu registo está criado" :
    state.status === "waitingForWorld" ? "Acesso aprovado" : "A preparar o teu registo";
  byId("status").textContent = state.status === "awaitingApproval" ? "Submete o formulário externo com o teu ID e aguarda a aprovação." :
    state.status === "waitingForWorld" ? "A entrar em Hogwarts…" : "A identificar o teu cliente. Aguarda um momento…";
  byId("user-id").value = state.userId || "";
  byId("form-url").value = typeof state.formUrl === "string" ? state.formUrl : "";
  byId("form-link").hidden = !state.formUrl;
  if (state.status === "identifying" && !registrationSent.has(state.sessionId)) {
    registrationSent.add(state.sessionId);
    // CEF storage can read as empty right after the game starts. Registering with a null key on an
    // account that already holds one is refused, so re-read once before declaring a new client.
    const attempt = retry => {
      try {
        const credential = localStorage.getItem(storageKey(state.serverKey));
        if (credential === null && retry > 0) { setTimeout(() => attempt(retry - 1), 1500); return; }
        send("register", { sessionId: state.sessionId, credential });
      } catch { byId("notice").textContent = "Não foi possível ler a chave local. Verifica o armazenamento do cliente ou contacta a equipa."; }
    };
    attempt(1);
  }
});
window.addEventListener("credential", event => {
  const value = event.detail;
  if (!value || typeof value.credential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.credential)) return;
  try {
    localStorage.setItem(storageKey(value.serverKey), value.credential);
    if (localStorage.getItem(storageKey(value.serverKey)) !== value.credential) throw new Error("Storage failed");
    send("credentialStored", { sessionId: value.sessionId });
  } catch { byId("notice").textContent = "Não foi possível guardar a chave local. Não será concedido acesso até este passo estar concluído."; }
});
window.addEventListener("notice", event => {
  byId("notice").textContent = typeof event.detail?.text === "string" ? event.detail.text : "";
});
for (const id of ["user-id", "form-url"]) byId(id).addEventListener("focus", () => byId(id).select());
send("ready", null);
