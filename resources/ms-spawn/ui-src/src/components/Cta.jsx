import CtaSeal from "./ornaments/CtaSeal.jsx";
import IconStar from "./icons/IconStar.jsx";
import Spinner from "./Spinner.jsx";

// Swallowtail ribbon with the seal on top and two stars (handoff §3.4). Idle and busy labels share one grid cell,
// so the size never changes.
//   disabled   real `disabled` attribute: no click, no hover, 50 % opacity. The owner always shows the reason as text.
//   loading    stays focusable (aria-busy) and ignores clicks, instead of using `disabled`, which would drop the focus.
//   className  extra class, e.g. "cta--panel" (full width, fits the 26 rem panel)
export default function Cta({ loading = false, disabled = false, busyLabel = "A entrar no mundo…", className = "", onClick, children }) {
  return (
    <button type="button" className={`cta ${className}`.trim()} disabled={disabled || undefined} aria-busy={loading || undefined}
      aria-disabled={loading || undefined} onClick={() => { if (!loading && !disabled) onClick?.(); }}>
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
