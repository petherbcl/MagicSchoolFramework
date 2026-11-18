import { useId } from "react";
import IconAlert from "./icons/IconAlert.jsx";

// Labelled text input. `error` (string) sets aria-invalid and an ember message with icon; help and error are
// both linked by aria-describedby. `busy` makes it readonly + aria-busy while a request is pending.
// The ref and every other prop go to the <input>.
export default function TextField({ label, error, help, busy = false, id, className = "", ref, ...props }) {
  const autoId = useId();
  const inputId = id || autoId;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const describedBy = [help && helpId, error && errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className}`.trim()}>
      <label htmlFor={inputId}>{label}</label>
      <input ref={ref} id={inputId} className="input" aria-invalid={error ? "true" : undefined} aria-describedby={describedBy}
        aria-busy={busy || undefined} readOnly={busy || props.readOnly} {...props} />
      {help && <p id={helpId} className="field__help">{help}</p>}
      {error && <p id={errorId} className="field__error"><IconAlert />{error}</p>}
    </div>
  );
}
