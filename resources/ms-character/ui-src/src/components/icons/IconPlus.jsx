// Plus in a ring of the "Criar nova personagem" slot.
// Source: symbol #i-plus, inline in docs/design/mockups/lobby.html.
export default function IconPlus(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false" {...props}>
      <circle cx="12" cy="12" r="9" strokeOpacity=".5"/>
      <path d="M12 7.5v9M7.5 12h9"/>
    </svg>
  );
}
