// MagicSchoolRP original ornament: top-left frame corner. Flip with transform: scale(-1,1) / scale(1,-1) / scale(-1,-1) for the other corners. Strokes use currentColor.
// Source: docs/design/assets/frame-corner.svg (inline JSX: inherits currentColor, no root color attribute).
export default function FrameCorner(props) {
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <path d="M1.5 46.5V13.5C1.5 6.9 6.9 1.5 13.5 1.5h33" strokeWidth="1.25"/>
      <path d="M6.5 30V15.5c0-5 4-9 9-9H30" strokeWidth="1" strokeOpacity=".55"/>
      <path d="M30 6.5c3.2 0 4.6 2.2 3.6 3.9-.9 1.5-3.3 1.2-3.3-.6" strokeWidth="1" strokeOpacity=".8"/>
      <path d="M6.5 30c0 3.2 2.2 4.6 3.9 3.6 1.5-.9 1.2-3.3-.6-3.3" strokeWidth="1" strokeOpacity=".8"/>
      <path d="M12.5 9.5l3 3-3 3-3-3z" fill="currentColor" stroke="none"/>
      <circle cx="20" cy="12.5" r=".9" fill="currentColor" stroke="none" opacity=".7"/>
      <circle cx="12.5" cy="20" r=".9" fill="currentColor" stroke="none" opacity=".7"/>
    </svg>
  );
}
