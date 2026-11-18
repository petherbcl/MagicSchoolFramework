import { useRef } from "react";
import Skeleton from "./Skeleton.jsx";

// Exclusive choice of 2 to 4 options with the WAI-ARIA radio pattern: roving tabindex, and the arrow keys move
// the focus AND the selection (wrapping at both ends). Names are always visible text.
//   options   [{ value, label, Crest? }]. `Crest` is a decorative crest component, used by variant "crests".
//   label / labelledBy   accessible name of the group (one of them is required). describedBy: id of a help text.
//   variant   "default" | "crests" (house picker: crest above the name, diamond in the corner).
//   disabled  aria-disabled on every item (no changes); loading shows skeleton placeholders and aria-busy.
export default function ChoiceGroup({ options, value, onChange, label, labelledBy, describedBy, variant = "default", disabled = false, loading = false, className = "" }) {
  const items = useRef([]);
  const crests = variant === "crests";
  const groupClass = `choice-group${crests ? " choice-group--crests" : ""} ${className}`.trim();
  const style = { "--cols": Math.min(Math.max(options.length, 2), 4) };

  if (loading) {
    return (
      <div className={groupClass} style={style} aria-busy="true" aria-label={label} aria-labelledby={labelledBy}>
        {options.map(option => <Skeleton key={option.value} style={{ height: crests ? "6.5rem" : "2.75rem" }} />)}
      </div>
    );
  }

  const checkedIndex = options.findIndex(option => option.value === value);
  const select = index => {
    if (disabled) return;
    const target = options[index];
    items.current[index]?.focus();
    if (target.value !== value) onChange?.(target.value);
  };
  const onKeyDown = (event, index) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    select((index + step + options.length) % options.length);
  };

  return (
    <div role="radiogroup" className={groupClass} style={style} aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-disabled={disabled || undefined}>
      {options.map((option, index) => {
        const checked = index === checkedIndex;
        const Crest = crests ? option.Crest : null;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={checked} aria-disabled={disabled || undefined}
            ref={node => { items.current[index] = node; }}
            tabIndex={checked || (checkedIndex < 0 && index === 0) ? 0 : -1}
            className={`choice${crests ? " choice--crest" : ""}`}
            onClick={() => select(index)} onKeyDown={event => onKeyDown(event, index)}>
            <span className="choice__mark" aria-hidden="true" />
            {Crest && <Crest />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
