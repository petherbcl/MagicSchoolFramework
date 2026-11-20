// Busy spinner of loading buttons and pending states (rotated by CSS, see .spinner).
// Source: symbol #i-spinner, inline in docs/design/mockups/states.html (also lobby.html, creator.html).
export default function IconSpinner(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false" {...props}>
      <circle cx="12" cy="12" r="9" strokeOpacity=".25"/>
      <path d="M21 12a9 9 0 0 0-9-9"/>
    </svg>
  );
}
