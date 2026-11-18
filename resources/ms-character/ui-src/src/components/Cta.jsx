import CtaSeal from "./ornaments/CtaSeal.jsx";
import IconStar from "./icons/IconStar.jsx";
import Spinner from "./Spinner.jsx";

// "Começar a jornada" ribbon (handoff §5, creator.html): swallowtail banner with the seal on top and two stars.
// Idle and busy labels share one grid cell, so the size never changes (min-width 22rem). While `loading` the
// button stays focusable (aria-busy) and ignores clicks, instead of using `disabled`, which would drop the focus.
// Validation errors never disable it: the click validates (the owner of `onClick`).
export default function Cta({ loading = false, busyLabel = "A criar…", onClick, children }) {
  return (
    <button type="button" className="cta" aria-busy={loading || undefined} aria-disabled={loading || undefined}
      onClick={() => { if (!loading) onClick?.(); }}>
      <span className="cta__shine" aria-hidden="true" />
      <CtaSeal className="cta__seal" />
      <span className="cta__stars" aria-hidden="true"><IconStar /><IconStar /></span>
      <span className="btn__stack">
        <span className="btn__idle">{children}</span>
        <span className="btn__busy" aria-hidden="true"><Spinner />{busyLabel}</span>
      </span>
    </button>
  );
}
