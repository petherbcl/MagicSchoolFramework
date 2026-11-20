import IconPin from "./IconPin.jsx";

// "Sem locais" board (handoff §3.1): dashed frame in place of the list. A dead end by design (D10): no button.
export default function SpawnEmpty() {
  return (
    <div className="spawn-empty">
      <IconPin />
      <strong>Sem locais disponíveis</strong>
      <p>Ainda não há locais de entrada configurados.</p>
    </div>
  );
}
