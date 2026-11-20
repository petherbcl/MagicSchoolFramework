import Divider from "./ornaments/Divider.jsx";
import FrameCorner from "./ornaments/FrameCorner.jsx";
import NoticeZone from "./NoticeZone.jsx";

// Single-column panel of the spawn screen (handoff §2): header, divider, scrolling content, status line, server
// notice zone and footer (the CTA). Adapted from the ms-character Screen: no avatar anchor, no key hint bar and no
// stage (the screen is mouse-only, D7, and nothing may sit over the world).
//   className   modifier of the screen, e.g. "screen--spawn" (narrow panel)
//   statusLine  node between the scroll area and the notice zone (the role="status" line)
//   footer      node under the notice zone
//   busy        aria-busy on <main>
//   inert       the panel is covered (CHG-02): no Tab, no focus, no clicks
//   panelRef    ref of <main>, so the owner can return the focus when the cover lifts
export default function Screen({ titleId, eyebrow = "MagicSchool RP", title, subtitle, className = "", busy = false, inert = false, panelRef, notice, statusLine, footer, children }) {
  return (
    <div className={`screen ${className}`.trim()}>
      <main ref={panelRef} className="panel" aria-labelledby={titleId} aria-busy={busy || undefined} inert={inert || undefined}>
        <header className="panel-header">
          <span className="panel-header__corner" aria-hidden="true"><FrameCorner /></span>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="panel-title" id={titleId}>{title}</h1>
          {subtitle && <p className="panel-subtitle">{subtitle}</p>}
        </header>
        <div className="divider" aria-hidden="true"><Divider /></div>
        <div className="panel__scroll">{children}</div>
        {statusLine}
        <NoticeZone text={notice} />
        {footer}
      </main>
    </div>
  );
}
