// Warning triangle of an invalid field error (also used by server notices).
// Source: symbol #i-alert, inline in docs/design/mockups/states.html and creator.html.
export default function IconAlert(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <path d="M12 3l9.5 17h-19z"/>
      <path d="M12 10v4.5M12 17.5h.01"/>
    </svg>
  );
}
