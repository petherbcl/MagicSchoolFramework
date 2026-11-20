import { useEffect, useState } from "react";

// Contract between this CEF page and client/main.js (the V8 client script). Plan §4.4.
// Payloads cross as JSON: page → client with callEvent(name, JSON.stringify(payload)),
// client → page as a window CustomEvent(name, { detail }). IDs are decimal strings.
//
// page → client
//   "ready"           null                                  Handshake; the client flushes the last state.
//   "select"          { characterId }                       → ms-character:select. Answer: state "applying" → "playing".
//   "create"          { firstName, lastName, house }        → ms-character:create; the client adds `look` from
//                                                            Creator.exportLook(). Answer: state with the new character.
//   "delete"          { characterId }                       → ms-character:delete. Answer: state without the character.
//   "camera:frame"    { framing: "body" | "face" }          CreatorPreview.setCamera(preset). The client owns the
//                                                            presets; the page only picks the framing.
//   "lobby:preview"   { characterId } | null                Apply that character's saved look locally (preview only),
//                                                            or restore the account look.
//   "creator:begin"   null                                  Creator.begin({ preserveCurrent: true }); the client
//                                                            answers with creator:schema (~250 ms).
//   "creator:cancel"  null                                  importLook(originalLook) + Creator.cancel().
//   "creator:patch"   { category, id, commit: boolean }     Creator.applyPatch({ [category]: id }); previews are
//                                                            debounced (80 ms), commit answers creator:state.
//   "creator:body"    { preset }                            applyPatch({ preset }) with a BodyFemale…/BodyMale… ID.
//                                                            The schema changes to the other body's IDs, so the
//                                                            client sends creator:schema again.
//   "creator:voice"   { tone: 0 | 1, pitch: -10..10 }       Creator.setVoice after 80 ms; also kept for the created look
//   "creator:voice:preview" null                           Creator.previewVoice() (after the change is applied); sent with every voice change
//   "model:rotate"    { delta }                              CreatorPreview.rotate(delta) (degrees, clamped by the client);
//                                                            buttons repeat while held, dragging over the avatar column too.
//   "creator:pronoun" { pronoun: "witch" | "wizard" }       Kept by the client and added to look.pronoun on create
//                                                            (independent of the body).
//
// client → page
//   "state"           { status, characters: LobbyCharacter[], maxCharacters, characterId }
//                     status: "loading" | "lobby" | "creating" | "deleting" | "applying" | "playing" | "closed"
//                     ("choosingSpawn" is handled by client/main.js and never reaches the page: ms-spawn owns the screen)
//                     worldLoaded: added by client/main.js. false while the world around the lobby spawn is still loading: the page shows only
//                     the opaque "A preparar o mundo" cover (no lobby, no preview model). Absent (dev mock) = no wait.
//                     groundSnapped (server → client script only): the game confirmed the ground under the lobby spawn (Player.teleport snapToGround).
//                     LobbyCharacter: { characterId, firstName, lastName, house,
//                                       lastPlayedAt: string | null (ISO), look: LookJson | null }
//   "notice"          { text }                              Server notice (pt-PT) for the alert zone.
//   "creator:schema"  { capabilities, categories: [{ id, options: string[] }], state }
//                     state: CreatorState { gender, selections, faceGear, facialHair, facialHairColor, pronoun }
//   "creator:state"   CreatorState                          Selection sync after creatorChanged.
//   "creator:error"   { code }                              The creator could not open; back to the lobby.
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

// `npm run dev` in a normal browser: simulate the server so the lobby can be built without the game.
// Looks are placeholders, not game IDs. The creator mock (creator:*) is below: a fake schema built from the real
// category counts in docs/ms-character-runtime-findings.md §2.1 (STORY-05.14).
const mockLook = ({ firstName, lastName, house }, gender, pronoun) =>
  ({ format: "mock", version: 1, gender, presets: {}, gear: [], pronoun, name: { first: firstName, last: lastName }, house });
// Built lazily so the production bundle (where mock() is dead code) carries no fake data.
function initialMockState() {
  const ana = { characterId: "1", firstName: "Ana", lastName: "Silva", house: "Ravenclaw", lastPlayedAt: "2026-11-16T21:40:00.000Z" };
  const tomas = { characterId: "2", firstName: "Tomás", lastName: "Ferreira", house: "Unaffiliated", lastPlayedAt: "2026-11-02T18:05:00.000Z" };
  return { status: "lobby", characters: [{ ...ana, look: mockLook(ana, "female", "witch") }, { ...tomas, look: null }], maxCharacters: 3, characterId: null };
}
let fake = null;
let nextId = 3;
let creator = null; // Open creator session: a CreatorState, or null.
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
const mockHandlers = {
  ready: () => setTimeout(() => emit("state", fake), 200),
  create: payload => setTimeout(() => {
    if (payload.firstName.trim().length < 2) return emit("notice", { text: "Usa nomes com 2 a 32 letras." });
    // The look comes from the open creator session, like the client does with Creator.exportLook().
    const look = mockLook(payload, creator?.gender === 1 ? "female" : "male", creator?.pronoun || "wizard");
    creator = null;
    const character = { characterId: String(nextId++), ...payload, lastPlayedAt: null, look };
    fake = { ...fake, characters: [...fake.characters, character] };
    emit("state", fake);
  }, 400),
  // Like the server, "deleting" is internal: the page only receives the final lobby state.
  delete: ({ characterId }) => setTimeout(() => {
    fake = { ...fake, characters: fake.characters.filter(character => character.characterId !== characterId) };
    emit("state", fake);
  }, 600),
  select: ({ characterId }) => {
    emit("state", { ...fake, status: "applying", characterId });
    setTimeout(() => emit("state", { ...fake, status: "playing", characterId }), 1500);
  },
  // Accepted without effect: in the game they drive the creator camera and the local look preview.
  "camera:frame": () => {},
  "lobby:preview": () => {},
  "model:rotate": () => {},
  "creator:begin": () => {
    const session = creator = initialCreatorState();
    // The real schema is null until the first creatorChanged, ~250 ms after begin().
    setTimeout(() => { if (creator === session) emitSchema(); }, 250);
  },
  "creator:cancel": () => { creator = null; },
  "creator:pronoun": ({ pronoun }) => { if (creator && (pronoun === "witch" || pronoun === "wizard")) creator.pronoun = pronoun; },
  "creator:voice": () => {},
  "creator:voice:preview": () => {},
  "creator:body": ({ preset }) => setTimeout(() => applyPreset(preset), CREATOR_LATENCY_MS),
  "creator:patch": ({ category, id, commit }) => setTimeout(() => {
    if (!creator) return;
    if (category === "preset") return applyPreset(id);
    if (!setSelection(creator, category, id)) return; // Like the game: an unknown ID is rejected without a change.
    if (commit) emit("creator:state", structuredClone(creator));
  }, CREATOR_LATENCY_MS),
};
// --- Creator mock (STORY-05.14) ------------------------------------------------------------------------------
// Fake schema from docs/ms-character-runtime-findings.md §2.1 (male body). Not game assets: only the shape of
// the IDs and the counts are real. glasses (5) and facialHair (20) have NO empty option in the schema: "Nenhum" is added by the UI as a first tile and
// maps to the empty ID "" (state default and valid patch value, see NONE_ABLE).
const CREATOR_LATENCY_MS = 15; // Measured applyPatch latency is 11-17 ms (findings §2).
const GENDER_WORD = ["Male", "Female"]; // CreatorState.gender: 0 male, 1 female.
const HEX_COLOURS = ["#1c1410", "#2b1d14", "#3d2a1c", "#5a3d26", "#7a5636", "#9c7648", "#c29a62", "#d8bf8a", "#8a8a8a", "#cfcfcf"];
const pad = (n, width = 3) => String(n).padStart(width, "0");
const range = (count, make) => Array.from({ length: count }, (_, index) => make(index + 1));
const letter = n => String.fromCharCode(96 + n); // 1 → "a"
// Categories whose selection lives at the top of CreatorState instead of in `selections`.
// Categories where the empty ID "" (Nenhum) is a valid value although the schema does not list it.
const NONE_ABLE = new Set(["glasses", "facialHair"]);
const TOP_LEVEL = { glasses: "faceGear", facialHair: "facialHair", facialHairColor: "facialHairColor" };
function mockCategories(gender) {
  const word = GENDER_WORD[gender];
  const marking = index => range(10, n => `Marking${word}00${index}${letter(n)}`);
  const categories = {
    // 30 mixed bodies for both genders; the body type is the one the selected preset belongs to.
    preset: range(15, n => [`BodyFemale${pad(n)}`, `BodyMale${pad(n)}`]).flat(),
    faceShape: range(15, n => `Face${word}${pad(n)}`),
    skin: range(24, n => `SkinColor${word}${pad(n)}`),
    hairStyle: range(50, n => `Hair${word}${pad(n)}`),
    hairColour: range(32, n => `HairColor${word}${pad(n)}`),
    browShape: range(20, n => `Eyebrow${word}${pad(n)}`),
    browColour: range(32, n => `EyebrowColor${word}${pad(n)}`),
    eyeColour: range(25, n => `EyeColor${word}${pad(n)}`),
    marking0: marking(0),
    marking1: marking(1),
    marking2: marking(2),
    ...(gender === 0 ? { marking3: range(5, n => `MarkingMale003${letter(n)}`) } : {}), // Absent on the female body.
    glasses: range(5, n => `GA_Face_${pad(n)}`),
    facialHair: ["M_Facial_zBase_FullBeard", ...range(19, n => `M_Facial_zBase_Style${pad(n + 1, 2)}`)],
    facialHairColor: ["hair", ...HEX_COLOURS],
    // Not in the plan §5.3.1 table: exercises the generic icon and the "own tab labelled with the ID" rule.
    mockUnknown: range(4, n => `MockUnknown${pad(n)}`),
  };
  return Object.entries(categories).map(([id, options]) => ({ id, options }));
}
// Every default is the first schema option (facial hair colour: "hair"), except the body and the NONE_ABLE categories (""= Nenhum).
function initialCreatorState() {
  const state = { gender: 0, selections: {}, faceGear: "", facialHair: "", facialHairColor: "hair", pronoun: "wizard" };
  for (const { id, options } of mockCategories(0)) {
    if (!Object.hasOwn(TOP_LEVEL, id)) state.selections[id] = options[0];
  }
  state.selections.preset = "BodyMale001";
  return state;
}
// Sets one selection if the ID exists in the current schema; returns whether it did.
function setSelection(state, category, id) {
  const entry = mockCategories(state.gender).find(item => item.id === category);
  if (!entry || !(entry.options.includes(id) || (id === "" && NONE_ABLE.has(category)))) return false;
  if (Object.hasOwn(TOP_LEVEL, category)) state[TOP_LEVEL[category]] = id;
  else state.selections[category] = id;
  return true;
}
function emitSchema() {
  emit("creator:schema", {
    capabilities: { version: 9, session: true, sessionHolder: "none", schema: true, state: true, patch: true, preview: true, look: true,
      facialHair: true, pronoun: true, hairColourHex: true, browColourHex: true, eyeColourHex: true, voicePreview: true },
    categories: mockCategories(creator.gender),
    state: structuredClone(creator),
  });
}
// A `preset` patch is the body switch. A preset of the other body swaps every ID (HairMale… → HairFemale…),
// drops marking3 on the female body and sends a new schema. A preset of the same body only changes the state.
function applyPreset(preset) {
  if (!creator || !mockCategories(creator.gender)[0].options.includes(preset)) return;
  const gender = preset.startsWith("BodyFemale") ? 1 : 0;
  if (gender === creator.gender) {
    creator.selections.preset = preset;
    return emit("creator:state", structuredClone(creator));
  }
  const swap = id => id.replace(GENDER_WORD[creator.gender], GENDER_WORD[gender]);
  const next = { ...creator, gender, selections: { preset } };
  for (const { id, options } of mockCategories(gender)) {
    if (id === "preset") continue;
    const previous = Object.hasOwn(TOP_LEVEL, id) ? creator[TOP_LEVEL[id]] : creator.selections[id];
    const swapped = typeof previous === "string" ? swap(previous) : undefined;
    const value = options.includes(swapped) || (swapped === "" && NONE_ABLE.has(id)) ? swapped : options[0];
    if (Object.hasOwn(TOP_LEVEL, id)) next[TOP_LEVEL[id]] = value;
    else next.selections[id] = value;
  }
  creator = next;
  emitSchema();
}
function mock(name, payload) {
  fake ??= initialMockState();
  if (Object.hasOwn(mockHandlers, name)) mockHandlers[name](payload);
}
