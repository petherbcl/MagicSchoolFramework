import AvatarAnchor from "./AvatarAnchor.jsx";
import Divider from "./ornaments/Divider.jsx";
import FrameCorner from "./ornaments/FrameCorner.jsx";
import KeyHints from "./KeyHints.jsx";
import NoticeZone from "./NoticeZone.jsx";

// Two-column screen layout of lobby.html and loading.html: the panel (title, divider, scrolling content, server
// notice zone) on the left, the transparent avatar anchor on the right and the key-hint strip over its bottom.
//   eyebrow           small text above the title (default "MagicSchool RP"; the creator shows "Criar personagem · N de 7")
//   title / subtitle  header texts; `subtitle` may be a node (e.g. the slot counter)
//   afterHeader       node between the header and the divider (the creator's tab bar)
//   stage             node over the avatar column, above the key hints (the creator's CTA)
//   subtitleClass     extra class of the subtitle <p> (it carries aria-live="polite")
//   busy              aria-busy on <main>
//   anchor            render the avatar anchor (false on the loading screen)
//   hints             KeyHints entries, or none
//   enter / exiting   screen transition classes (200 ms enter, 150 ms exit)
//   inert             the whole screen is inert (while a dialog is open)
export default function Screen({
  titleId, eyebrow = "MagicSchool RP", title, subtitle, afterHeader, stage, subtitleClass = "", busy = false, notice, anchor = true, hints,
  enter = false, exiting = false, inert = false, scrollHidden = false, children,
}) {
  return (
    <div className={`screen${exiting ? " screen-exit" : ""}`} inert={inert || undefined}>
      <main className={`panel${enter ? " screen-enter" : ""}`} aria-labelledby={titleId} aria-busy={busy || undefined}>
        <header className="panel-header">
          <span className="panel-header__corner" aria-hidden="true"><FrameCorner /></span>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="panel-title" id={titleId}>{title}</h1>
          {subtitle && <p className={`panel-subtitle ${subtitleClass}`.trim()} aria-live="polite">{subtitle}</p>}
        </header>
        {afterHeader}
        <div className="divider" aria-hidden="true"><Divider /></div>
        <div className="panel__scroll" aria-hidden={scrollHidden || undefined}>{children}</div>
        <NoticeZone text={notice} />
      </main>
      {anchor && <AvatarAnchor />}
      {(hints || stage) && <div className="stage-actions">{stage}{hints && <KeyHints hints={hints} />}</div>}
    </div>
  );
}
