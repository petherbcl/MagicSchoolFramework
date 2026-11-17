import { useEffect, useState } from "react";

// Contract with client/main.js (the V8 client script):
//   page → client: callEvent(name, JSON.stringify(payload)) for "ready", "create", "select"
//   client → page: CustomEvent "state" { status, characters, maxCharacters, characterId } and "notice" { text }
const native = typeof window.callEvent === "function";

export function send(name, payload = null) {
  if (native) window.callEvent(name, JSON.stringify(payload));
  else if (import.meta.env.DEV) mock(name, payload);
}

export function useLobby() {
  const [state, setState] = useState(null);
  // Each notice is a new object so repeating the same text still re-renders (and unlocks buttons).
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    const onState = event => { if (event.detail && typeof event.detail.status === "string") { setState(event.detail); setNotice(null); } };
    const onNotice = event => setNotice(typeof event.detail?.text === "string" ? { text: event.detail.text } : null);
    window.addEventListener("state", onState);
    window.addEventListener("notice", onNotice);
    send("ready"); // Readiness handshake: the client script flushes the last state after this.
    return () => { window.removeEventListener("state", onState); window.removeEventListener("notice", onNotice); };
  }, []);
  return { state, notice };
}

// `npm run dev` in a normal browser: simulate the server so screens can be built without the game.
let fake = { status: "lobby", characters: [{ characterId: "1", firstName: "Ana", lastName: "Silva", house: "Ravenclaw" }], maxCharacters: 3, characterId: null };
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
function mock(name, payload) {
  if (name === "ready") setTimeout(() => emit("state", fake), 200);
  if (name === "create") setTimeout(() => {
    if (payload.firstName.trim().length < 2) return emit("notice", { text: "Usa nomes com 2 a 32 letras." });
    const id = String(fake.characters.length + 1);
    fake = { ...fake, characters: [...fake.characters, { characterId: id, ...payload }] };
    emit("state", fake);
  }, 400);
  if (name === "select") { emit("state", { ...fake, status: "applying" }); setTimeout(() => emit("state", { ...fake, status: "lobby" }), 1500); }
}
