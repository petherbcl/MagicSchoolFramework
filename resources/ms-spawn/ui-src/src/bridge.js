import { useCallback, useEffect, useReducer } from "react";

// Contract between this CEF page and client/main.js (the V8 client script). Plan docs/architecture-plan-ms-spawn.md §4.3.
// Payloads cross as JSON: page → client with callEvent(name, JSON.stringify(payload)), client → page as a window
// CustomEvent(name, { detail }). The client script relays the server events ms-spawn:open / ms-spawn:state to the page
// under the short names below, and owns the camera (the page never sees a pose or a spawn point).
//
// page → client
//   "ready"    null            Handshake; the client flushes the last "open" / "state" / "camera" after it.
//   "select"   { id }          → ms-spawn:select { id }. The client also starts (or restarts) the camera flight.
//   "confirm"  { id }          → ms-spawn:confirm { id }. Answer: state "applying", or state "choosing" + notice (rejected).
//
// client → page
//   "open"     { locations: [{ id, name, kind: "last" | "config", camera: { position: {x,y,z}, rotation: {pitch,yaw,roll} } }] }
//              ← ms-spawn:open. Resets the screen. `camera` is for the client only; the page ignores it.
//   "state"    { status: "choosing" | "applying" | "closed", selectedId?: string, notice?: string }
//              ← ms-spawn:state. `notice` is pt-PT text for the alert zone. "choosing" + notice = server rejection (D11):
//              the selection and the camera stay. "closed" after "applying" = success (the client hides the page);
//              "closed" in any other case = session lost.
//   "notice"   { text }        Standalone pt-PT notice for the alert zone (also releases a pending "applying" and lifts the cover).
//                              While a location is selected and the camera has not arrived, a notice is a preparation failure
//                              (CHG-02): the selection stays, the CTA is disabled and clicking the same location retries.
//   "camera"   { status: "flying" | "arrived", id }
//              Camera progress for the selected location, sent by the client script (flight start, arrival).
//              Informational for the UI only: the server never trusts it. Ignored when `id` is not the current selection.
//              A legacy "streaming" is still accepted and treated as "flying" (the area now loads under the cover).
//   "cover"    { visible: boolean, moment: "choosing" | "confirm" }   (CHG-02, handoff §9)
//              The total opaque cover. The page already turns it on by itself, in the same frame, on its own "select"
//              ("choosing") and "confirm" ("confirm"), so a client "visible: true" only re-asserts it. "visible: false"
//              lifts it (150 ms fade) when `moment` is the one currently shown; a stale moment is ignored.
//              The cover is also lifted by any "notice", a server rejection ("choosing" + notice), "closed" and "open".
//              Success of a confirm: "closed" after "applying" keeps the cover on (the client hides the page).
//
// IDs are strings. Unknown events and malformed payloads are ignored.
const native = typeof window.callEvent === "function";

export function send(name, payload = null) {
  if (native) window.callEvent(name, JSON.stringify(payload));
  else if (import.meta.env.DEV) mock(name, payload);
}

const CAMERA_STATUSES = ["flying", "streaming", "arrived"]; // "streaming" is legacy: mapped to "flying"
const COVER_MOMENTS = ["choosing", "confirm"];
const SERVER_STATUSES = ["choosing", "applying", "closed"];

// Keeps only well-formed entries; the "last" entry is unique and first (the list shows it before the others).
function parseLocations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = value.filter(item => item && typeof item.id === "string" && item.id && typeof item.name === "string" && !seen.has(item.id) && seen.add(item.id))
    .map(item => ({ id: item.id, name: item.name, kind: item.kind === "last" ? "last" : "config" }));
  const last = items.find(item => item.kind === "last");
  return [...(last ? [last] : []), ...items.filter(item => item !== last && item.kind !== "last")];
}

export const initialSpawn = Object.freeze({
  locations: null, // null until the first "open"
  status: "choosing", // server status: "choosing" | "applying" | "closed"
  selectedId: null,
  camera: null, // null | "flying" | "arrived" (for selectedId)
  cover: null, // null | "choosing" | "confirm": the moment of the cover while it is on
  coverMoment: null, // last moment shown, kept while the cover fades out so its text never changes mid-fade
  failed: false, // the last preparation of selectedId failed: selection kept, CTA disabled, same location retries
  notice: null, // { text } | null, a new object per notice so a repeated text re-renders
  lost: false,
});

const coverOn = (state, moment) => ({ cover: moment, coverMoment: moment });
// A notice while a location is selected and the camera has not arrived is a preparation failure (handoff §9.5).
const failedAfter = (state, hasNotice) => Boolean(hasNotice) && state.selectedId !== null && state.camera !== "arrived";

export function spawnReducer(state, action) {
  switch (action.type) {
    case "open":
      return { ...initialSpawn, locations: parseLocations(action.detail?.locations) };
    case "state": {
      const detail = action.detail;
      if (!detail || !SERVER_STATUSES.includes(detail.status)) return state;
      const text = typeof detail.notice === "string" && detail.notice ? { text: detail.notice } : null;
      const adopted = state.selectedId === null && typeof detail.selectedId === "string" && state.locations?.some(item => item.id === detail.selectedId)
        ? detail.selectedId : state.selectedId;
      if (detail.status === "closed") {
        if (state.status === "applying" && !text) return state; // success: the client hides the page; keep the cover on
        return { ...state, status: "closed", lost: true, notice: text, cover: null, failed: false }; // session lost always lifts the cover
      }
      if (state.lost) return state;
      if (detail.status === "applying") return { ...state, status: "applying", selectedId: adopted, notice: null, failed: false, ...coverOn(state, "confirm") };
      // "choosing": the echo of a select keeps the "choosing" cover; an answer to a confirm (rejection) or a notice lifts it.
      const lifted = text || state.cover === "confirm";
      return { ...state, status: "choosing", selectedId: adopted, notice: text, ...(lifted ? { cover: null, failed: failedAfter(state, text) } : {}) };
    }
    case "notice": {
      if (typeof action.detail?.text !== "string" || !action.detail.text) return state;
      return { ...state, status: state.status === "applying" ? "choosing" : state.status, notice: { text: action.detail.text }, cover: null, failed: failedAfter(state, true) };
    }
    case "camera": {
      const detail = action.detail;
      if (!detail || !CAMERA_STATUSES.includes(detail.status) || detail.id !== state.selectedId) return state;
      return { ...state, camera: detail.status === "streaming" ? "flying" : detail.status, failed: false };
    }
    case "cover": { // client → page; see the contract above
      const detail = action.detail;
      if (!detail || typeof detail.visible !== "boolean" || !COVER_MOMENTS.includes(detail.moment)) return state;
      if (detail.visible) return state.lost ? state : { ...state, ...coverOn(state, detail.moment) };
      return state.cover === detail.moment ? { ...state, cover: null } : state;
    }
    case "select": // local, optimistic: a click always (re)starts the flight and clears the old notice
      // CHG-02: the cover goes on in the same frame (never toggled off/on by a re-selection) and the flight starts later.
      return state.lost || state.status === "applying" ? state : { ...state, selectedId: action.id, camera: null, failed: false, notice: null, ...coverOn(state, "choosing") };
    case "confirm": // local, optimistic: unlocked again by the server's "choosing" state or notice
      return state.lost || state.status !== "choosing" || state.selectedId === null || state.camera !== "arrived" || state.cover
        ? state : { ...state, status: "applying", notice: null, ...coverOn(state, "confirm") };
    default:
      return state;
  }
}

export function useSpawn() {
  const [state, dispatch] = useReducer(spawnReducer, initialSpawn);
  useEffect(() => {
    const listeners = ["open", "state", "notice", "camera", "cover"].map(type => [type, event => dispatch({ type, detail: event.detail })]);
    for (const [type, listener] of listeners) window.addEventListener(type, listener);
    send("ready"); // Readiness handshake: the client script flushes the last events after this.
    return () => { for (const [type, listener] of listeners) window.removeEventListener(type, listener); };
  }, []);
  const select = useCallback(id => { dispatch({ type: "select", id }); send("select", { id }); }, []);
  const confirm = useCallback(id => { dispatch({ type: "confirm" }); send("confirm", { id }); }, []);
  return { state, select, confirm };
}

// --- Mocked server for `npm run dev:ui` ------------------------------------------------------------------------
// Simulates the client script and the server in a normal browser so every state can be reached without the game
// (the review toolbar in ./dev flips the flags). Not game data: the camera poses are placeholders and nothing here is
// used by the page. Timings follow docs/design/mockups/spawn.html (CHG-02: the area loads under the cover, then the flight). Dead code in the production bundle.
const FLIGHT_MS = 1400;
const COVER_MS = 1600; // area loading under the cover
const COVER_SLOW_MS = 4000;
const APPLY_MS = 2600;
const REOPEN_MS = 1500;
const FAIL_NOTICE = "Não foi possível preparar este local. Tenta de novo ou escolhe outro local.";
const REJECT_NOTICE = "O servidor rejeitou este local. Escolhe outro local e tenta de novo.";
const LOST_NOTICE = "Perdeste a ligação à sessão. Volta a entrar no servidor para continuares.";
const camera = { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 } };
const BASE = [["hogsmeade", "Hogsmeade"], ["hogwarts-gates", "Portões de Hogwarts"], ["feldcroft", "Feldcroft"]];
const MORE = ["Lago de Hogwarts", "Floresta Proibida", "Cais de Hogsmeade", "Torre de Astronomia", "Pátio das Estufas",
  "Cabana do Guarda-Caça", "Ponte de Madeira", "Vale de Poidh", "Ruínas do Norte"];
export const mockFlags = { last: true, many: false, slow: false, fail: false, reject: false, empty: false };
let timer = 0;
let arrivedId = null;
let selectedId = null;
let lost = false;
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

function mockLocations() {
  if (mockFlags.empty) return [];
  const list = [...BASE, ...(mockFlags.many ? MORE.map((name, index) => [`extra-${index}`, name]) : [])].map(([id, name]) => ({ id, name, kind: "config", camera }));
  return mockFlags.last ? [{ id: "last", name: "Última localização", kind: "last", camera }, ...list] : list;
}
export function mockOpen() {
  clearTimeout(timer);
  arrivedId = selectedId = null;
  lost = false;
  emit("open", { locations: mockLocations() });
}
export function mockLose() {
  clearTimeout(timer);
  lost = true;
  emit("state", { status: "closed", notice: LOST_NOTICE });
}
const mockHandlers = {
  ready: () => setTimeout(mockOpen, 200),
  select: ({ id }) => {
    if (lost) return;
    clearTimeout(timer);
    arrivedId = null;
    selectedId = id;
    emit("state", { status: "choosing", selectedId: id });
    emit("cover", { visible: true, moment: "choosing" }); // already on (the page turns it on itself); a new select only restarts the wait
    timer = setTimeout(() => { // the area is loaded (or the ceiling hit) under the cover
      if (mockFlags.fail) { // failure: lift the cover, then the notice
        emit("cover", { visible: false, moment: "choosing" });
        return emit("notice", { text: FAIL_NOTICE });
      }
      emit("cover", { visible: false, moment: "choosing" });
      emit("camera", { status: "flying", id });
      timer = setTimeout(() => { arrivedId = id; emit("camera", { status: "arrived", id }); }, FLIGHT_MS);
    }, mockFlags.slow ? COVER_SLOW_MS : COVER_MS);
  },
  confirm: ({ id }) => {
    if (lost || id !== selectedId || id !== arrivedId) return;
    emit("state", { status: "applying", selectedId: id });
    emit("cover", { visible: true, moment: "confirm" });
    timer = setTimeout(() => {
      if (mockFlags.reject) {
        emit("cover", { visible: false, moment: "confirm" });
        return emit("state", { status: "choosing", selectedId: id, notice: REJECT_NOTICE });
      }
      emit("state", { status: "closed", selectedId: id });
      timer = setTimeout(mockOpen, REOPEN_MS); // the real client hides the page here; the mock starts over
    }, APPLY_MS);
  },
};
function mock(name, payload) {
  if (Object.hasOwn(mockHandlers, name)) mockHandlers[name](payload);
}
