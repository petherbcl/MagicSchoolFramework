import { useId } from "react";

// MagicSchoolRP ORIGINAL crest for Slytherin: deep-green shield, silver rim, serpentine wave (water). Not derived from the official crest.
// Source: docs/design/assets/crest-slytherin.svg. Decorative (aria-hidden): the house name is always visible text.
// Fixed house palette by design (no currentColor); useId keeps the gradient ID unique per instance.
export default function CrestSlytherin(props) {
  const field = `${useId()}-field`;
  return (
    <svg viewBox="0 0 64 76" width="64" height="76" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id={field} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#2E6B4A"/>
          <stop offset="1" stopColor="#183F2B"/>
        </linearGradient>
      </defs>
      <path d="M32 2L60 8v28c0 18-12.5 30-28 38C16.5 66 4 54 4 36V8z" fill={`url(#${field})`} stroke="#C3CBD0" strokeWidth="2"/>
      <path d="M32 6.5L56 11.6V36c0 15.5-10.5 26-24 33.4C18.5 62 8 51.5 8 36V11.6z" fill="none" stroke="#C3CBD0" strokeWidth=".75" strokeOpacity=".6"/>
      <path d="M38.5 20.5c-3-2.5-13-2-13 4.5 0 7.5 14 6 14 14.5 0 7-10 8.5-14 4.5" fill="none" stroke="#C3CBD0" strokeWidth="3.5" strokeLinecap="round"/>
      <path d="M25.5 44c-1.5 2-1 4.5 1 5.5" fill="none" stroke="#C3CBD0" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="37.6" cy="20.2" r="2.6" fill="#C3CBD0"/>
      <path d="M18 56c4.5-2.5 9-2.5 14 0s9.5 2.5 14 0" fill="none" stroke="#C3CBD0" strokeWidth="1.25" strokeLinecap="round" strokeOpacity=".7"/>
    </svg>
  );
}
