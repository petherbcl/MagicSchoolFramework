import CtaSeal from "./ornaments/CtaSeal.jsx";
import Divider from "./ornaments/Divider.jsx";

// Opaque full-screen loading cover (loading.html "loading-screen"): seal, title, divider, status line and three pulsing
// diamonds. Shared by the "entering" variant of Loading and copied by ms-spawn (resources share no imports, so ms-spawn
// keeps its own copy with the same class names). It depends only on the two ornaments and on the classes in components.css.
//   title, sub  the texts (the sub line is the persistent role="status")
//   busy        aria-busy while the cover is up
//   className   extra classes appended after "loading-screen" (none for "entering": the markup stays identical)
//   titleId     id of the heading and its aria-labelledby target
//   heading     heading element, "h1" by default (a page that already has an h1 passes "h2")
export default function LoadingCover({ title, sub, busy = true, className = "", titleId = "entering-title", heading: Heading = "h1" }) {
  return (
    <section className={className ? "loading-screen " + className : "loading-screen"} aria-labelledby={titleId} aria-busy={busy ? "true" : undefined}>
      <div>
        <CtaSeal className="loading-screen__seal" />
        <Heading className="loading-screen__title" id={titleId}>{title}</Heading>
        <div className="divider loading-screen__divider" aria-hidden="true"><Divider /></div>
        <p className="loading-screen__sub" role="status">{sub}</p>
        <div className="dots" aria-hidden="true"><i /><i /><i /></div>
      </div>
    </section>
  );
}
