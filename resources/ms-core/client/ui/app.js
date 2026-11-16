"use strict";
const byId = id => document.getElementById(id);
const send = (name, payload) => { if (typeof window.callEvent === "function") window.callEvent(name, JSON.stringify(payload)); };
const storageKey = serverKey => "ms-core:credential:" + serverKey;
const registrationSent = new Set();
let busy = false;
window.addEventListener("session", event => {
  const state = event.detail;
  if (!state || typeof state.status !== "string") return;
  busy = false; byId("notice").textContent = "";
  byId("registration").hidden = !state.userId || state.status !== "awaitingApproval";
  byId("selection").hidden = state.status !== "selectingCharacter";
  byId("heading").textContent = state.status === "awaitingApproval" ? "O teu registo está criado" :
    state.status === "selectingCharacter" ? "A tua personagem" : "A preparar o teu registo";
  byId("status").textContent = state.status === "awaitingApproval" ? "Submete o formulário externo com o teu ID e aguarda a aprovação." :
    state.status === "selectingCharacter" ? "Escolhe quem vais interpretar." : "A identificar o teu cliente. Aguarda um momento…";
  byId("user-id").value = state.userId || "";
  byId("form-url").value = typeof state.formUrl === "string" ? state.formUrl : "";
  byId("form-link").hidden = !state.formUrl;
  if (state.status === "identifying" && !registrationSent.has(state.sessionId)) {
    try {
      const credential = localStorage.getItem(storageKey(state.serverKey));
      registrationSent.add(state.sessionId);
      send("register", { sessionId: state.sessionId, credential });
    } catch { byId("notice").textContent = "Não foi possível ler a chave local. Verifica o armazenamento do cliente ou contacta a equipa."; }
  }
  const characters = Array.isArray(state.characters) ? state.characters : [];
  const list = byId("characters"); list.replaceChildren();
  for (const character of characters) {
    const card = document.createElement("div"); card.className = "character";
    const title = document.createElement("p"); title.textContent = `${character.firstName} ${character.lastName} · ${character.house}`;
    const button = document.createElement("button"); button.textContent = "Entrar com esta personagem";
    button.addEventListener("click", () => {
      if (busy) return; busy = true; button.disabled = true;
      send("selectCharacter", { characterId: character.characterId });
    });
    card.append(title, button); list.append(card);
  }
  byId("create").hidden = characters.length >= state.maxCharacters;
  byId("create").querySelector("button").disabled = false;
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
  busy = false;
  byId("notice").textContent = typeof event.detail?.text === "string" ? event.detail.text : "";
  document.querySelectorAll("button").forEach(button => { button.disabled = false; });
});
for (const id of ["user-id", "form-url"]) byId(id).addEventListener("focus", () => byId(id).select());
byId("create").addEventListener("submit", event => {
  event.preventDefault(); if (busy) return;
  busy = true; byId("create").querySelector("button").disabled = true;
  const form = new FormData(event.currentTarget);
  send("createCharacter", { firstName: form.get("firstName"), lastName: form.get("lastName"), house: form.get("house") });
});
send("ready", null);
