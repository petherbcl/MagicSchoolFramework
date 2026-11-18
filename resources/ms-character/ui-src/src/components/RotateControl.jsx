import { useEffect, useRef } from "react";
import { send } from "../bridge.js";

// Turns the character the game draws (CreatorPreview.rotate). Two buttons that repeat while held, and a drag
// handler for the avatar anchor. The client clamps every delta, so the page can stay simple.
const STEP_DEG = 3, REPEAT_MS = 30, DRAG_DEG_PER_PX = 0.4;

export const rotate = delta => send("model:rotate", { delta });

// Drag over the transparent avatar column: dragging right turns the character to the right.
export function useDragRotate() {
  const last = useRef(null);
  return {
    onPointerDown: event => { last.current = event.clientX; event.currentTarget.setPointerCapture?.(event.pointerId); },
    onPointerMove: event => {
      if (last.current === null) return;
      const dx = event.clientX - last.current; last.current = event.clientX;
      if (dx) rotate(dx * DRAG_DEG_PER_PX);
    },
    onPointerUp: () => { last.current = null; },
    onPointerCancel: () => { last.current = null; },
  };
}

function TurnButton({ direction, label, children }) {
  const timer = useRef(null);
  const stop = () => { if (timer.current !== null) { clearInterval(timer.current); timer.current = null; } };
  const start = () => { stop(); rotate(direction * STEP_DEG); timer.current = setInterval(() => rotate(direction * STEP_DEG), REPEAT_MS); };
  useEffect(() => stop, []);
  return (
    <button type="button" className="rotate__btn" aria-label={label} title={label}
      onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onBlur={stop}
      onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && !event.repeat) rotate(direction * STEP_DEG * 3); }}>
      {children}
    </button>
  );
}

export default function RotateControl() {
  return (
    <div className="rotate" role="group" aria-label="Rodar personagem">
      <TurnButton direction={-1} label="Rodar para a esquerda">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 3-6.2M4 4v4.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </TurnButton>
      <span className="rotate__label">Rodar</span>
      <TurnButton direction={1} label="Rodar para a direita">
        <svg viewBox="0 0 24 24" aria-hidden="true" style={{ transform: "scaleX(-1)" }}><path d="M4 12a8 8 0 1 0 3-6.2M4 4v4.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </TurnButton>
    </div>
  );
}
