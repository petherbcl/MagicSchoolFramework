import { useState } from "react";
import Skeleton from "./Skeleton.jsx";
import IconChevronLeft from "./icons/IconChevronLeft.jsx";
import IconChevronRight from "./icons/IconChevronRight.jsx";

// Stepped slider of numbered options (STORY-05.07), WAI-ARIA slider pattern.
//   options      array of option ids, in order. Option N is `options[N - 1]`.
//   value        id of the confirmed option.
//   label        accessible group name used by the arrow buttons ("<label>: opção anterior/seguinte").
//   labelledBy   id of the group subtitle element that names the slider (falls back to `label`).
//   onPreview    (id) the pointer is over the track at that option (never confirms). On leaving the track it is
//                called with the confirmed `value`. The caller debounces (80 ms).
//   onCommit     (id) the value changed by keyboard, arrow button or click on the track.
//   disabled     aria-disabled track and disabled arrows. `loading` shows a skeleton the width of the track.
// One dot per option, whatever the count (every slider keeps the same look).
// The marker moves only by `transform` (--p), the dashed ghost under the pointer by --g.
const PAGE = 5;

export default function StepSlider({ options, value, label, labelledBy, onPreview, onCommit, disabled = false, loading = false, className = "" }) {
  const [ghost, setGhost] = useState(null); // Index under the pointer.
  const total = options.length;
  if (loading) return <Skeleton className={className} style={{ height: "2.75rem", width: "100%" }} />;

  const found = options.indexOf(value);
  const index = found >= 0 ? found : 0;
  const fraction = i => (total > 1 ? i / (total - 1) : 0);
  const go = next => {
    const clamped = Math.min(total - 1, Math.max(0, next)); // No wrap at the ends.
    if (disabled || clamped === index) return;
    onCommit?.(options[clamped]);
  };
  const indexAt = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || total < 2) return 0;
    return Math.min(total - 1, Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * (total - 1))));
  };
  const onKeyDown = event => {
    const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: PAGE, PageDown: -PAGE }[event.key];
    if (delta !== undefined) go(index + delta);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(total - 1);
    else return;
    event.preventDefault();
  };

  const marks = [];
  for (let k = 1; k <= total; k++) marks.push(<span key={k} className="step-dot" style={{ "--i": fraction(k - 1) }} />);

  return (
    <div className={`step-slider ${className}`.trim()}>
      <button type="button" className="step-arrow" tabIndex={-1} disabled={disabled || index === 0}
        aria-label={`${label}: opção anterior`} onClick={() => go(index - 1)}><IconChevronLeft /></button>
      <div className="step-track" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
        aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label}
        aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1} aria-valuetext={`Opção ${index + 1} de ${total}`}
        onKeyDown={onKeyDown}
        onMouseMove={event => {
          if (disabled) return;
          const next = indexAt(event);
          if (next === ghost) return;
          setGhost(next);
          onPreview?.(options[next]);
        }}
        onMouseLeave={() => { if (ghost === null) return; setGhost(null); onPreview?.(value); }}
        onClick={event => go(indexAt(event))}>
        <span className="step-line" />
        {marks}
        <span className="step-ghost-rail" style={{ "--g": fraction(ghost ?? index) }}><span className="step-ghost" /></span>
        <span className="step-rail" style={{ "--p": fraction(index) }}><span className="step-marker" /></span>
      </div>
      <button type="button" className="step-arrow" tabIndex={-1} disabled={disabled || index === total - 1}
        aria-label={`${label}: opção seguinte`} onClick={() => go(index + 1)}><IconChevronRight /></button>
      <output className="step-readout" aria-hidden="true">{index + 1} <span>/ {total}</span></output>
    </div>
  );
}
