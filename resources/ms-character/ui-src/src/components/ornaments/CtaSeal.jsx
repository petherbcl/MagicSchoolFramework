import { useId } from "react";

// MagicSchoolRP original seal: medallion on top of the "Começar a jornada" ribbon and on the
// "A entrar em Hogwarts" screen. Eight-point star in a double ring; not derived from any game asset.
// Source: docs/design/assets/cta-seal.svg. Multi-colour by design (fixed palette, no currentColor).
export default function CtaSeal(props) {
  const fill = `${useId()}-seal-fill`;
  return (
    <svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <radialGradient id={fill} cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="#E8CF96"/>
          <stop offset=".6" stopColor="#B89A5E"/>
          <stop offset="1" stopColor="#7A6440"/>
        </radialGradient>
      </defs>
      <circle cx="28" cy="28" r="26" fill="#13202B" stroke="#D5B87B" strokeWidth="1.5"/>
      <circle cx="28" cy="28" r="21" fill={`url(#${fill})`}/>
      <circle cx="28" cy="28" r="18" fill="none" stroke="#6E1D19" strokeWidth="1" strokeDasharray="1.5 2.5"/>
      <path d="M28 12l3 10.5L41 18l-6.5 8.5L44 28l-9.5 1.5L41 38l-10-4.5L28 44l-3-10.5L15 38l6.5-8.5L12 28l9.5-1.5L15 18l10 4.5z" fill="#6E1D19"/>
      <circle cx="28" cy="28" r="3.2" fill="#E8CF96"/>
    </svg>
  );
}
