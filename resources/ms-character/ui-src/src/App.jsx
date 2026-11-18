import { useEffect, useRef, useState } from "react";
import { send, useLobby } from "./bridge.js";
import CharacterList, { sortByRecent } from "./components/CharacterList.jsx";
import CreateCharacter from "./components/CreateCharacter.jsx";
import DeleteDialog from "./components/DeleteDialog.jsx";
import Loading from "./components/Loading.jsx";
import Screen from "./components/Screen.jsx";
import WorldVignette from "./components/WorldVignette.jsx";

const LOADING_EXIT_MS = 150; // the loading panel fades out before the next screen enters (200 ms)
const NO_SLOTS = "Atingiste o limite de personagens. Apaga uma personagem para criares outra.";
const DELETE_TIMEOUT_MS = 10000; // the server never answered a delete: unblock the dialog (STORY-05.12, minor point of 05.09)
const CREATOR_FAILED = "Não foi possível abrir o criador. Tenta de novo; se o problema persistir, contacta a equipa.";
const DELETE_FAILED = "Não foi possível apagar a personagem. Tenta de novo; se o problema persistir, contacta a equipa.";
const LOBBY_HINTS = [{ keys: ["Tab"], label: "Navegar" }, { keys: ["Enter"], label: "Jogar" }, { keys: ["Del"], label: "Apagar" }];
// Vignette variant per displayed screen; "entering" is opaque and has none.
const VIGNETTE = { loading: "loading", lobby: "lobby", creator: "creator", entering: null };

// Which screen the server state asks for. "playing" keeps the opaque screen until the client closes the page.
function targetScreen(state, creating, creatorFailed) {
  if (!state || state.status === "loading") return "loading";
  if (state.status === "applying" || state.status === "playing") return "entering";
  if (creatorFailed) return "lobby"; // creator:error: show the lobby (also without characters) with the notice
  const count = state.characters.length;
  // Without characters the lobby goes straight to the creation form.
  return count < state.maxCharacters && (creating || count === 0) ? "creator" : "lobby";
}

// Holds the loading screen for its 150 ms exit before showing the next one (no intermediate screen).
function useScreen(target) {
  const [shown, setShown] = useState(target);
  if (shown !== target && shown !== "loading") setShown(target);
  useEffect(() => {
    if (shown !== "loading" || target === "loading") return undefined;
    const timer = setTimeout(() => setShown(target), LOADING_EXIT_MS);
    return () => clearTimeout(timer);
  }, [shown, target]);
  return { screen: shown, exiting: shown === "loading" && target !== "loading" };
}

export default function App() {
  const { state, notice } = useLobby();
  const [creating, setCreating] = useState(false);
  const [creatorFailed, setCreatorFailed] = useState(false); // creator:error: back to the lobby with a notice
  const [busy, setBusy] = useState(false);       // create in flight
  const [busyId, setBusyId] = useState(null);    // character being entered
  // Delete dialog: { characterId, name, status: "idle" | "deleting" | "error" | "done", state0, notice0 }.
  const [dialog, setDialog] = useState(null);
  const [ignoredNotice, setIgnoredNotice] = useState(null);
  const deleteRefs = useRef(new Map());          // characterId -> "Apagar" button
  const refocus = useRef(null);                  // where the focus goes once the dialog is gone
  const previewed = useRef(null);
  const framed = useRef(false);
  const creatorEntry = useRef({ screen: null, notice: null }); // the notice already on screen when the creator opened

  const characters = sortByRecent(state?.characters || []);
  const count = characters.length;
  const { screen, exiting } = useScreen(targetScreen(state, creating, creatorFailed));
  // A notice that was already there when the creator opened (an old failure) must not show in it. Idempotent, so it
  // is safe during render (StrictMode renders twice).
  if (creatorEntry.current.screen !== screen) creatorEntry.current = { screen, notice };
  const creatorNotice = screen === "creator" && notice !== creatorEntry.current.notice ? notice : null;

  // Any server answer (new state or notice) unlocks the buttons; a longer list means creation succeeded.
  useEffect(() => { setBusy(false); setBusyId(null); }, [state, notice]);
  useEffect(() => { setCreating(false); }, [count]);

  // Answer to a delete request: a state without the character is success; a notice, or a state that still
  // has it (the server sends the lobby state before the notice on failure), is an error. A request that timed
  // out ("timedOut") still accepts a late success.
  useEffect(() => {
    setDialog(current => {
      const waiting = current?.status === "deleting";
      if (!current || (!waiting && !(current.status === "error" && current.timedOut))) return current;
      if (waiting && notice && notice !== current.notice0) return { ...current, status: "error" };
      if (state && state !== current.state0) {
        if (!state.characters.some(item => item.characterId === current.characterId)) return { ...current, status: "done" };
        return waiting ? { ...current, status: "error" } : current;
      }
      return current;
    });
  }, [state, notice]);

  // No state and no notice within the limit: the dialog must not stay blocked forever.
  useEffect(() => {
    if (dialog?.status !== "deleting") return undefined;
    const timer = setTimeout(() => setDialog(current => (current?.status === "deleting" ? { ...current, status: "error", timedOut: true } : current)), DELETE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [dialog?.status]);

  // Entering the lobby: frame the character once (the shift is the client's) and forget the last preview.
  useEffect(() => {
    if (screen === "lobby") {
      if (!framed.current) { framed.current = true; send("camera:frame", { framing: "body" }); }
    } else { framed.current = false; previewed.current = null; }
  }, [screen]);

  // Keyboard-only players: the lobby starts with the first action focused, so Enter does what the hint says.
  useEffect(() => {
    if (screen !== "lobby") return undefined;
    const frame = requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) document.querySelector(".char-card .btn--primary, .slot-new")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [screen]);

  // Focus goes back to the "Apagar" button of the card that opened the dialog (or to the first card after a delete).
  useEffect(() => {
    if (dialog || !refocus.current) return;
    const target = refocus.current;
    refocus.current = null;
    const element = target === "first" ? document.querySelector(".char-card .btn--primary, .slot-new") : deleteRefs.current.get(target);
    element?.focus();
  }, [dialog]);

  const working = busy || busyId !== null || state?.status === "creating" || state?.status === "deleting";
  const preview = characterId => {
    if (previewed.current === characterId) return;
    previewed.current = characterId;
    send("lobby:preview", { characterId });
  };
  const openDelete = character => {
    if (working || dialog) return;
    setDialog({ characterId: character.characterId, name: `${character.firstName} ${character.lastName}`, status: "idle" });
  };
  const confirmDelete = () => {
    if (!dialog || dialog.status === "deleting") return;
    setDialog({ ...dialog, status: "deleting", timedOut: false, state0: state, notice0: notice });
    send("delete", { characterId: dialog.characterId });
  };
  const closeDialog = () => {
    refocus.current = dialog?.status === "done" ? "first" : dialog?.characterId;
    if (dialog?.status !== "idle") setIgnoredNotice(notice); // a delete failure was already shown inside the dialog
    setDialog(null);
  };

  let content;
  if (screen === "loading") content = <Loading exiting={exiting} />;
  else if (screen === "entering") content = <Loading variant="entering" />;
  else if (screen === "creator") {
    content = (
      <CreateCharacter hasCharacters={count > 0} busy={busy} notice={creatorNotice}
        onSubmit={input => { setBusy(true); send("create", input); }}
        onExit={() => setCreating(false)}
        onFailed={() => { setCreating(false); setCreatorFailed(true); }} />
    );
  } else {
    const max = state.maxCharacters;
    const canCreate = count < max;
    const serverNotice = dialog || notice === ignoredNotice ? null : notice?.text;
    content = (
      <Screen titleId="lobby-title" title="Escolhe a tua personagem" busy={working} enter inert={Boolean(dialog)}
        subtitleClass="slot-count" hints={LOBBY_HINTS} notice={creatorFailed ? CREATOR_FAILED : serverNotice || (!canCreate && count > 0 ? NO_SLOTS : null)}
        subtitle={
          <>
            <span className="slot-pips" aria-hidden="true">
              {Array.from({ length: max }, (_, index) => <i key={index} className={index < count ? "is-filled" : undefined} />)}
            </span>
            <span>{count} de {max} {max === 1 ? "personagem" : "personagens"}</span>
          </>
        }>
        <CharacterList characters={characters} maxCharacters={max} busyId={busyId} disabled={working || state.status !== "lobby"}
          canCreate={canCreate} deleteRefs={deleteRefs} onPreview={preview} onDelete={openDelete} onCreate={() => { setCreatorFailed(false); setCreating(true); }}
          onSelect={characterId => { setBusyId(characterId); send("select", { characterId }); }} />
      </Screen>
    );
  }

  return (
    <>
      <WorldVignette variant={VIGNETTE[screen]} />
      {content}
      {dialog && (
        <DeleteDialog busy={dialog.status === "deleting"} done={dialog.status === "done"}
          error={dialog.status === "error" ? DELETE_FAILED : null} onConfirm={confirmDelete} onClosed={closeDialog}>
          Apagar <strong>{dialog.name}</strong>? Esta ação não pode ser desfeita por ti.
        </DeleteDialog>
      )}
    </>
  );
}
