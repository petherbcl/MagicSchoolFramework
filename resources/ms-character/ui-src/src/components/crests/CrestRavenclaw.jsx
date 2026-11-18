import { useId } from "react";

// MagicSchoolRP ORIGINAL crest for Ravenclaw: midnight-blue shield, bronze rim, quill feather (air). Not derived from the official crest.
// Source: docs/design/assets/crest-ravenclaw.svg. Decorative (aria-hidden): the house name is always visible text.
// Fixed house palette by design (no currentColor); useId keeps the gradient ID unique per instance.
export default function CrestRavenclaw(props) {
  const field = `${useId()}-field`;
  return (
    <svg viewBox="0 0 64 76" width="64" height="76" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id={field} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#2C4A7A"/>
          <stop offset="1" stopColor="#1B2F52"/>
        </linearGradient>
      </defs>
      <path d="M32 2L60 8v28c0 18-12.5 30-28 38C16.5 66 4 54 4 36V8z" fill={`url(#${field})`} stroke="#B07D4E" strokeWidth="2"/>
      <path d="M32 6.5L56 11.6V36c0 15.5-10.5 26-24 33.4C18.5 62 8 51.5 8 36V11.6z" fill="none" stroke="#B07D4E" strokeWidth=".75" strokeOpacity=".6"/>
      <path d="M42 16c-11 3-17.5 13.5-17.5 28.5l-2.5 9 3.3-6.5C37 45 43 31 42 16z" fill="#B07D4E"/>
      <path d="M41 18.5C35 26 30 35 25.5 46" fill="none" stroke="#1B2F52" strokeWidth="1" strokeLinecap="round"/>
      <path d="M33 30l-4.5.5M36 25l-4 .3M30.5 36l-4 .8" fill="none" stroke="#1B2F52" strokeWidth=".8" strokeLinecap="round"/>
    </svg>
  );
}
