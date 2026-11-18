import { useId } from "react";

// MagicSchoolRP ORIGINAL crest for Hufflepuff: ochre shield, dark rim, wheat ear (earth). Not derived from the official crest.
// Source: docs/design/assets/crest-hufflepuff.svg. Decorative (aria-hidden): the house name is always visible text.
// Fixed house palette by design (no currentColor); useId keeps the gradient ID unique per instance.
export default function CrestHufflepuff(props) {
  const field = `${useId()}-field`;
  return (
    <svg viewBox="0 0 64 76" width="64" height="76" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id={field} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#E2B53E"/>
          <stop offset="1" stopColor="#B8892A"/>
        </linearGradient>
      </defs>
      <path d="M32 2L60 8v28c0 18-12.5 30-28 38C16.5 66 4 54 4 36V8z" fill={`url(#${field})`} stroke="#2A2620" strokeWidth="2"/>
      <path d="M32 6.5L56 11.6V36c0 15.5-10.5 26-24 33.4C18.5 62 8 51.5 8 36V11.6z" fill="none" stroke="#2A2620" strokeWidth=".75" strokeOpacity=".55"/>
      <g fill="#2A2620">
        <path d="M31.2 22h1.6v36h-1.6z"/>
        <ellipse cx="32" cy="20" rx="2.4" ry="4"/>
        <ellipse cx="28" cy="27" rx="2.2" ry="4" transform="rotate(-30 28 27)"/>
        <ellipse cx="36" cy="27" rx="2.2" ry="4" transform="rotate(30 36 27)"/>
        <ellipse cx="28" cy="34" rx="2.2" ry="4" transform="rotate(-30 28 34)"/>
        <ellipse cx="36" cy="34" rx="2.2" ry="4" transform="rotate(30 36 34)"/>
        <ellipse cx="28" cy="41" rx="2.2" ry="4" transform="rotate(-30 28 41)"/>
        <ellipse cx="36" cy="41" rx="2.2" ry="4" transform="rotate(30 36 41)"/>
      </g>
      <path d="M24 52c4-3 12-3 16 0" fill="none" stroke="#2A2620" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}
