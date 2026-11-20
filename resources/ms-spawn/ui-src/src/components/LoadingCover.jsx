import CtaSeal from "./ornaments/CtaSeal.jsx";
import Divider from "./ornaments/Divider.jsx";

// Total opaque cover (CHG-02, handoff §9). Adapted copy of the ms-character "entering" loading screen, with the
// differences of handoff §9.7: always mounted (`visible` toggles `is-on`, so the 150 ms fade-out can run), `aria-busy`
// follows `visible`, <h2> instead of <h1> (the page already has one) and no entry animation (show is instant).
//   title    h2 text. The caller keeps the last text while the cover fades out
//   sub      text of the persistent role="status" line (injected after the first render so it is announced)
//   visible  show (instant) / hide (fade-out)
//   busy     aria-busy; follows `visible` unless given
//   className extra class on the section
export default function LoadingCover({ title = "", sub = "", visible = false, busy = visible, className = "" }) {
  return (
    <section className={`loading-screen spawn-cover${visible ? " is-on" : ""} ${className}`.trim()} aria-labelledby="cover-title" aria-busy={busy}>
      <div>
        <CtaSeal className="loading-screen__seal spawn-cover__seal" />
        <h2 className="loading-screen__title" id="cover-title">{title}</h2>
        <div className="divider spawn-cover__divider" aria-hidden="true"><Divider /></div>
        <p className="loading-screen__sub" role="status">{sub}</p>
        <div className="dots" aria-hidden="true"><i /><i /><i /></div>
      </div>
    </section>
  );
}
