import { useId } from "react";

// MagicSchoolRP ORIGINAL crest for Gryffindor: crimson shield, gold rim, stylised flame (fire). Not derived from the official crest.
// Source: docs/design/assets/crest-gryffindor.svg. Decorative (aria-hidden): the house name is always visible text.
// Fixed house palette by design (no currentColor); useId keeps the gradient ID unique per instance.
export default function CrestGryffindor(props) {
  const field = `${useId()}-field`;
  return (
    <svg viewBox="0 0 64 76" width="64" height="76" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id={field} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#A3342A"/>
          <stop offset="1" stopColor="#6E1D19"/>
        </linearGradient>
      </defs>
      <path d="M32 2L60 8v28c0 18-12.5 30-28 38C16.5 66 4 54 4 36V8z" fill={`url(#${field})`} stroke="#D9A441" strokeWidth="2"/>
      <path d="M32 6.5L56 11.6V36c0 15.5-10.5 26-24 33.4C18.5 62 8 51.5 8 36V11.6z" fill="none" stroke="#D9A441" strokeWidth=".75" strokeOpacity=".6"/>
      <path d="M32 18c4.5 6.5 11 11 11 20.5a11 11 0 0 1-22 0c0-5.5 3.2-8.6 5.5-11.8.2 4.3 2.1 6.6 4.2 6.8-1.2-5.2 0-10.4 1.3-15.5z" fill="#D9A441"/>
      <path d="M32 34c2 3 4.5 4.8 4.5 8.5a4.5 4.5 0 0 1-9 0c0-2.8 2.6-4.6 4.5-8.5z" fill="#6E1D19"/>
    </svg>
  );
}
