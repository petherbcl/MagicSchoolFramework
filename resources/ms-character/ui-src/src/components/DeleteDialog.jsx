import { useEffect, useId, useRef, useState } from "react";
import Button from "./Button.jsx";
import Frame from "./Frame.jsx";
import Divider from "./ornaments/Divider.jsx";
import NoticeZone from "./NoticeZone.jsx";

const CLOSE_MS = 150; // exit animation (opacity/transform only)

// Confirmation dialog (delete-dialog.html). The default texts are "Apagar personagem"; "Descartar personagem"
// (STORY-05.12) passes its own through props: title "Descartar personagem", children "Sair do criador? As
// alterações que fizeste perdem-se.", cancelLabel "Continuar a editar", confirmLabel "Descartar".
//   children     body text (a node, e.g. Apagar <strong>Ana Silva</strong>? …)
//   busy         the request is in flight: both buttons disabled, confirm shows the spinner, Esc and the scrim do nothing
//   error        text shown in the dialog's alert zone (the dialog is active again)
//   done         the request succeeded: the dialog plays its exit and calls onClosed
//   onConfirm    the user confirmed
//   onClosed     called after the exit animation (Cancelar, Esc, scrim or `done`); the owner unmounts the dialog and
//                returns the focus to the element that opened it
// Initial focus is on the cancel button; Tab is contained in the dialog and Esc always leaves (not a trap).
export default function DeleteDialog({
  title = "Apagar personagem", cancelLabel = "Cancelar", confirmLabel = "Apagar", busyLabel = "A apagar",
  busy = false, error = null, done = false, onConfirm, onClosed, children,
}) {
  const titleId = useId(), bodyId = useId();
  const dialogRef = useRef(null), cancelRef = useRef(null), closedRef = useRef(onClosed);
  const [dismissed, setDismissed] = useState(false);
  const closing = dismissed || done;
  closedRef.current = onClosed;

  // Initial focus on Cancelar; again when a request ends (the buttons were disabled, so focus was lost).
  useEffect(() => { if (!busy && !closing) cancelRef.current?.focus(); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!closing) return undefined;
    const timer = setTimeout(() => closedRef.current?.(), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!busy && !closing) setDismissed(true);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const items = [...(dialogRef.current?.querySelectorAll("button:not(:disabled)") || [])];
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
        items[next].focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, closing]);

  return (
    <div className={closing ? "is-closing" : undefined}>
      <div className="scrim" onClick={() => { if (!busy && !closing) setDismissed(true); }} />
      <div className="dialog-host">
        <Frame as="section" ref={dialogRef} className="dialog" role="alertdialog" aria-modal="true"
          aria-labelledby={titleId} aria-describedby={bodyId} aria-busy={busy || undefined}>
          <h2 className="dialog__title" id={titleId}>{title}</h2>
          <div className="divider" aria-hidden="true"><Divider /></div>
          <p className="dialog__body" id={bodyId}>{children}</p>
          <NoticeZone text={error} />
          <div className="dialog__actions">
            {/* DOM order is the Tab order: Cancelar first, with the initial focus. */}
            <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={() => { if (!busy && !closing) setDismissed(true); }}>{cancelLabel}</Button>
            <Button variant="danger" loading={busy} busyLabel={busyLabel} onClick={() => { if (!busy && !closing) onConfirm?.(); }}>{confirmLabel}</Button>
          </div>
        </Frame>
      </div>
    </div>
  );
}
