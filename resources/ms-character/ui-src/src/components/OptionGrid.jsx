import { useRef, useState } from "react";
import Skeleton from "./Skeleton.jsx";
import IconCheck from "./icons/IconCheck.jsx";
import IconNone from "./icons/IconNone.jsx";

// Numbered option tiles (STORY-05.06) with live preview. WAI-ARIA listbox + roving tabindex: the arrow keys move
// the focus in 2D and PREVIEW the option, only click / Enter / Space COMMIT it. This is why it is a listbox and
// not a radiogroup (radios select on arrow).
//   options      [id | { id, disabled? }]. The schema options, numbered "Opção 1".."Opção N" in this order.
//   none         adds a first tile "Nenhum" (id ""). It is a UI-only tile: it is not part of `options`, is not
//                numbered and does not count towards the schema count (glasses 5, facialHair 20).
//   value        id of the confirmed option ("" selects "Nenhum"; undefined/null selects nothing).
//   labelledBy   id of the group subtitle element (required for the accessible name).
//   onPreview    (id) hover/focus; never confirms. When the pointer or the focus leaves the grid it is called
//                with the confirmed `value` (the caller debounces, 80 ms).
//   onCommit     (id) the player confirmed the option.
//   disabled     aria-disabled on the grid and every tile (no preview, no commit). `loading` shows skeletons.
const NONE = "";

export default function OptionGrid({ options, value, none = false, labelledBy, onPreview, onCommit, disabled = false, loading = false, className = "" }) {
  const gridRef = useRef(null);
  const tiles = useRef([]);
  const [roving, setRoving] = useState(null); // Index with tabindex 0 while the grid has focus; null = the confirmed one.
  const [previewing, setPreviewing] = useState(null); // Index shown with the preview style (hover or focus).
  const [hovered, setHovered] = useState(false);

  const items = [
    ...(none ? [{ id: NONE, none: true, disabled: false }] : []),
    ...options.map((option, index) => {
      const isObject = typeof option === "object" && option !== null;
      return { id: isObject ? option.id : option, number: index + 1, disabled: isObject && Boolean(option.disabled) };
    }),
  ];
  const gridClass = `option-grid ${className}`.trim();

  if (loading) {
    return (
      <div className={gridClass} aria-busy="true" aria-labelledby={labelledBy}>
        {items.map(item => <Skeleton key={item.id === NONE ? "none" : item.id} style={{ aspectRatio: "1" }} />)}
      </div>
    );
  }

  const selectedIndex = items.findIndex(item => item.id === value);
  const tabStop = roving ?? (selectedIndex >= 0 ? selectedIndex : 0);
  const blocked = item => disabled || item.disabled;

  const preview = index => {
    setPreviewing(index);
    if (!blocked(items[index])) onPreview?.(items[index].id);
  };
  // Back to the confirmed option. If the keyboard focus is still inside the grid it is the option the focus shows.
  const restore = () => {
    const focused = tiles.current.findIndex(node => node && node === document.activeElement);
    if (focused >= 0 && !blocked(items[focused])) { setPreviewing(focused); onPreview?.(items[focused].id); return; }
    setPreviewing(null);
    onPreview?.(value);
  };
  const commit = index => {
    if (blocked(items[index])) return;
    setRoving(index);
    onCommit?.(items[index].id);
  };
  const moveFocus = index => {
    setRoving(index);
    tiles.current[index]?.focus(); // The focus handler previews.
  };
  // Columns of the auto-fill grid, read from the layout: tiles sharing the first tile's row.
  const columns = () => {
    const top = tiles.current[0]?.offsetTop;
    return Math.max(1, tiles.current.filter(node => node && node.offsetTop === top).length);
  };
  const onKeyDown = (event, index) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(index);
      return;
    }
    const last = items.length - 1;
    let target;
    switch (event.key) {
      case "ArrowRight": target = Math.min(last, index + 1); break;
      case "ArrowLeft": target = Math.max(0, index - 1); break;
      case "Home": target = 0; break;
      case "End": target = last; break;
      case "ArrowDown":
      case "ArrowUp": {
        const cols = columns();
        const delta = event.key === "ArrowDown" ? cols : -cols;
        if (index + delta < 0) target = index;
        else if (index + delta > last) target = Math.floor(index / cols) < Math.floor(last / cols) ? last : index; // Partial last row.
        else target = index + delta;
        break;
      }
      default: return;
    }
    event.preventDefault();
    if (target !== index) moveFocus(target);
  };

  return (
    <div ref={gridRef} role="listbox" className={gridClass} aria-labelledby={labelledBy} aria-disabled={disabled || undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); restore(); }}
      onBlur={event => {
        if (gridRef.current?.contains(event.relatedTarget)) return; // Focus moving between tiles.
        setRoving(null);
        if (hovered) return; // The pointer still previews.
        setPreviewing(null);
        onPreview?.(value);
      }}>
      {items.map((item, index) => (
        <button key={item.id === NONE ? "none" : item.id} type="button" role="option" aria-selected={index === selectedIndex}
          aria-disabled={blocked(item) || undefined}
          aria-label={item.none ? "Nenhum" : `Opção ${item.number}`}
          ref={node => { tiles.current[index] = node; }}
          tabIndex={index === tabStop ? 0 : -1}
          className={`tile${item.none ? " tile--none" : ""}${previewing === index ? " is-previewing" : ""}`}
          onMouseEnter={() => preview(index)}
          onFocus={() => { setRoving(index); preview(index); }}
          onClick={() => commit(index)}
          onKeyDown={event => onKeyDown(event, index)}
          onKeyUp={event => { if (event.key === " ") event.preventDefault(); }}>
          {item.none ? <IconNone /> : <span aria-hidden="true">{item.number}</span>}
          <span className="tile__check" aria-hidden="true"><IconCheck /></span>
        </button>
      ))}
    </div>
  );
}
