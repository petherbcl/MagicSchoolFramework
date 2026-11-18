// MagicSchoolRP original icon: GENERIC fallback for unknown/runtime categories (four-point spark in a ring).
// Source: docs/design/assets/icon-generic.svg (inline JSX: inherits currentColor, no root color attribute).
export default function IconGeneric(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <circle cx="12" cy="12" r="9.25" strokeOpacity=".45" strokeDasharray="2 2.5"/>
      <path d="M12 4.5l1.6 5.9 5.9 1.6-5.9 1.6L12 19.5l-1.6-5.9L4.5 12l5.9-1.6z"/>
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>
    </svg>
  );
}
