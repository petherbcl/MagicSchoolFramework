// MagicSchoolRP original ornament: symmetric end cap for the gold rule (filete) under group subtitles. The line itself is a CSS gradient.
// Source: docs/design/assets/rule-cap.svg (inline JSX: inherits currentColor, no root color attribute).
export default function RuleCap(props) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false" {...props}>
      <path d="M6 1.5L10.5 6 6 10.5 1.5 6z" fill="none" stroke="currentColor" strokeWidth="1"/>
      <circle cx="6" cy="6" r="1.4" fill="currentColor"/>
    </svg>
  );
}
