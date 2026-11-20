import { useId } from "react";

// MagicSchoolRP original ornament: centred title divider (used under the panel title and in dialogs).
// Source: docs/design/assets/divider.svg. The fade gradients use currentColor so the whole ornament
// inherits the text colour; useId keeps the gradient IDs unique when several dividers render.
export default function Divider(props) {
  const id = useId();
  return (
    <svg viewBox="0 0 480 16" width="480" height="16" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id={`${id}-fade-l`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity="0"/>
          <stop offset="1" stopColor="currentColor" stopOpacity="1"/>
        </linearGradient>
        <linearGradient id={`${id}-fade-r`} x1="1" x2="0" y1="0" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity="0"/>
          <stop offset="1" stopColor="currentColor" stopOpacity="1"/>
        </linearGradient>
      </defs>
      <path d="M8 8h196" stroke={`url(#${id}-fade-l)`} strokeWidth="1"/>
      <path d="M276 8h196" stroke={`url(#${id}-fade-r)`} strokeWidth="1"/>
      <path d="M204 8c6 0 9-5 14-5s6 4 3 5.5" strokeWidth="1"/>
      <path d="M276 8c-6 0-9 5-14 5s-6-4-3-5.5" strokeWidth="1"/>
      <path d="M240 2l6 6-6 6-6-6z" strokeWidth="1"/>
      <path d="M240 5.5l2.5 2.5-2.5 2.5-2.5-2.5z" fill="currentColor" stroke="none"/>
      <circle cx="226" cy="8" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="254" cy="8" r="1.2" fill="currentColor" stroke="none"/>
    </svg>
  );
}
