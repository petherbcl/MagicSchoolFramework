import { useId } from "react";
import Spinner from "./Spinner.jsx";

const VARIANTS = Object.freeze({
  primary: "btn--primary",
  secondary: "btn--secondary",
  danger: "btn--danger",
  "quiet-danger": "btn--quiet-danger",
});

// Props:
//   variant       "primary" | "secondary" | "danger" | "quiet-danger"
//   icon          optional icon element shown before the label (e.g. <IconTrash/>)
//   loading       true while a request is pending: shows the spinner and `busyLabel`, sets aria-busy and
//                 disables the button. Idle and busy labels share one grid cell, so the size never changes.
//   busyLabel     short busy text ("A entrar", "Aguarda", "A apagar")
//   disabledReason  text explaining why the button is disabled, shown below it and linked by aria-describedby
export default function Button({
  variant = "primary", icon = null, loading = false, busyLabel = "Aguarda", disabled = false,
  disabledReason, type = "button", className = "", children, ...props
}) {
  const reasonId = useId();
  const { "aria-describedby": describedBy, ...rest } = props;
  const showReason = disabled && !loading && Boolean(disabledReason);
  const button = (
    <button {...rest} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      aria-describedby={showReason ? reasonId : describedBy}
      className={`btn ${VARIANTS[variant] || VARIANTS.primary} ${className}`.trim()}>
      <span className="btn__stack">
        <span className="btn__idle">{icon}{children}</span>
        <span className="btn__busy" aria-hidden="true"><Spinner />{busyLabel}</span>
      </span>
    </button>
  );
  if (!showReason) return button;
  return <>{button}<p id={reasonId} className="btn__reason">{disabledReason}</p></>;
}
