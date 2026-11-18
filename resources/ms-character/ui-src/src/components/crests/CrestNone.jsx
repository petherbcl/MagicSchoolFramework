import { useId } from "react";

// MagicSchoolRP ORIGINAL crest for "Sem casa atribuída": neutral ink shield, brass rim, open star (not yet sorted).
// Source: docs/design/assets/crest-none.svg. Decorative (aria-hidden): the house name is always visible text.
// Fixed house palette by design (no currentColor); useId keeps the gradient ID unique per instance.
export default function CrestNone(props) {
  const field = `${useId()}-field`;
  return (
    <svg viewBox="0 0 64 76" width="64" height="76" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id={field} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1F3546"/>
          <stop offset="1" stopColor="#13202B"/>
        </linearGradient>
      </defs>
      <path d="M32 2L60 8v28c0 18-12.5 30-28 38C16.5 66 4 54 4 36V8z" fill={`url(#${field})`} stroke="#D5B87B" strokeWidth="2"/>
      <path d="M32 6.5L56 11.6V36c0 15.5-10.5 26-24 33.4C18.5 62 8 51.5 8 36V11.6z" fill="none" stroke="#D5B87B" strokeWidth=".75" strokeOpacity=".45" strokeDasharray="2 2.5"/>
      <path d="M32 22l3.4 8.6 9.2.6-7.1 5.9 2.3 9-7.8-5-7.8 5 2.3-9-7.1-5.9 9.2-.6z" fill="none" stroke="#D5B87B" strokeWidth="1.5" strokeLinejoin="round"/>
      <circle cx="32" cy="35" r="1.6" fill="#D5B87B"/>
    </svg>
  );
}
