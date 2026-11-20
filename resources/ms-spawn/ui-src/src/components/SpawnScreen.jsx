import { useEffect, useRef } from "react";
import { useSpawn } from "../bridge.js";
import Cta from "./Cta.jsx";
import LoadingCover from "./LoadingCover.jsx";
import Screen from "./Screen.jsx";
import SpawnEmpty from "./SpawnEmpty.jsx";
import SpawnList from "./SpawnList.jsx";
import SpawnStatus from "./SpawnStatus.jsx";

// Copy of handoff §3.1 / §3.2 (pt-PT). Server notices arrive as text; these two are the page's own fallbacks for the
// dead-end states, where there is deliberately no exit button (D10).
const LOST_NOTICE = "Perdeste a ligação à sessão. Volta a entrar no servidor para continuares.";
const EMPTY_NOTICE = "Não há locais disponíveis. Contacta a equipa; ainda não é possível entrar no mundo.";

// Cover copy (handoff §9.3), by moment. No location name: the text never changes width or line between selections.
const COVER_COPY = Object.freeze({
  choosing: ["A preparar o local", "A carregar a zona. Aguarda um momento…"],
  confirm: ["A entrar no mundo", "A carregar o mundo à tua volta. Aguarda um momento…"],
});

// Screen state, derived (handoff §3.1 / §9.2): lost | empty | applying | covering | failed | idle | flying | arrived.
// "applying" and "covering" are the two moments of the total cover (the panel is inert behind it).
// The CTA is active only in "arrived": a location is selected AND the camera arrived AND the area is loaded (D8).
export function phaseOf(state) {
  if (state.lost) return "lost";
  if (state.locations && state.locations.length === 0) return "empty";
  if (state.status === "applying" || state.cover === "confirm") return "applying";
  if (state.cover === "choosing") return "covering";
  if (state.selectedId === null) return "idle";
  if (state.failed) return "failed";
  return state.camera ?? "flying";
}

function statusLine(phase, name) {
  const bold = <strong>{name}</strong>;
  switch (phase) {
    case "idle":
    case "failed": return "Escolhe um local para o sobrevoares.";
    case "flying": return <span>A voar até {bold}…</span>;
    case "arrived": return <span>Chegaste a {bold}. Confirma para apareceres aqui.</span>;
    case "applying": return <span>A entrar em {bold}…</span>;
    default: return null; // covering (the cover carries the message), lost, empty (the reason is in the notice zone)
  }
}

export default function SpawnScreen() {
  const { state, select, confirm } = useSpawn();
  const phase = phaseOf(state);
  const locations = state.locations ?? [];
  const selected = locations.find(item => item.id === state.selectedId);
  const applying = phase === "applying";
  const covered = state.cover !== null && !state.lost;
  const [coverTitle, coverSub] = COVER_COPY[state.coverMoment] ?? ["", ""]; // kept while fading out
  const loaded = state.locations !== null;
  const notice = state.notice?.text ?? (phase === "lost" ? LOST_NOTICE : phase === "empty" ? EMPTY_NOTICE : null);

  // Focus (handoff §9.5): when the cover lifts, back to the selected item, or to the CTA after a server rejection.
  const panelRef = useRef(null);
  const wasCover = useRef(null);
  useEffect(() => {
    const before = wasCover.current;
    wasCover.current = covered ? state.cover : null;
    if (before === null || covered || !panelRef.current) return;
    const target = before === "confirm" ? ".cta" : '.spawn-item[aria-pressed="true"]';
    const element = panelRef.current.querySelector(target);
    if (element && !element.disabled) element.focus({ preventScroll: true });
  }, [covered, state.cover]);

  const onSelect = id => { if (!(id === state.selectedId && phase === "arrived")) select(id); }; // a click elsewhere restarts the flight

  return (
    <>
    <Screen panelRef={panelRef} inert={covered} titleId="spawn-title" className="screen--spawn" title="Escolhe onde aparecer" busy={applying} notice={notice}
      subtitle="Clica num local para o sobrevoares. Depois, confirma."
      statusLine={<SpawnStatus busy={phase === "flying" || applying}>{loaded ? statusLine(phase, selected?.name) : null}</SpawnStatus>}
      footer={
        <div className="spawn-footer">
          <Cta className="cta--panel" disabled={phase !== "arrived" && !applying} loading={applying} busyLabel="A entrar no mundo…"
            onClick={() => state.selectedId && confirm(state.selectedId)}>Aparecer aqui</Cta>
        </div>
      }>
      {loaded && (locations.length === 0
        ? <SpawnEmpty />
        : <SpawnList locations={locations} selectedId={state.selectedId} flyingId={phase === "flying" ? state.selectedId : null}
            locked={applying || phase === "lost"} onSelect={onSelect} />)}
    </Screen>
    <LoadingCover visible={covered} title={coverTitle} sub={coverSub} />
    </>
  );
}
