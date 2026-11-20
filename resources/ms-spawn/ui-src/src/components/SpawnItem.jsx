import IconCheck from "./icons/IconCheck.jsx";
import IconSpinner from "./icons/IconSpinner.jsx";
import IconStar from "./icons/IconStar.jsx";
import IconPin from "./IconPin.jsx";

// One location (handoff §3.3): a full-width toggle button, grid `icon · name · 1.5 rem slot`. The slot has a fixed
// size so nothing moves between spinner, check and empty.
//   kind      "last" (gold star + accent bar) or "config" (pin)
//   selected  aria-pressed. Selected is shown by border + glow AND by the check or the spinner, never by colour alone
//   flying    the camera is still flying / the area is still loading: spinner + progress line instead of the check
//   disabled  applying or session lost (the chosen item stays fully opaque)
export default function SpawnItem({ name, kind = "config", selected = false, flying = false, disabled = false, onSelect }) {
  const isLast = kind === "last";
  const Icon = isLast ? IconStar : IconPin;
  return (
    <button type="button" className={`spawn-item${isLast ? " spawn-item--last" : ""}${flying ? " is-flying" : ""}`}
      aria-pressed={selected} disabled={disabled} onClick={onSelect}>
      <Icon className="spawn-item__icon" />
      <span className="spawn-item__name">{name}</span>
      <span className="spawn-item__slot" aria-hidden="true">
        <IconSpinner className="spawn-item__spin" />
        <IconCheck className="spawn-item__check" />
      </span>
      <span className="spawn-item__progress" aria-hidden="true" />
    </button>
  );
}
