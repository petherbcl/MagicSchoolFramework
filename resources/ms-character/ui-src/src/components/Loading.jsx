import CtaSeal from "./ornaments/CtaSeal.jsx";
import Divider from "./ornaments/Divider.jsx";
import Screen from "./Screen.jsx";
import Skeleton from "./Skeleton.jsx";

// Loading screens (loading.html). Neither renders an AvatarAnchor.
//   variant "characters" (status "loading"): the lobby layout with two skeleton cards; the world vignette is the
//                        --loading variant (rendered by App). `exiting` plays the 150 ms exit when the lobby or
//                        the creator replaces it.
//   variant "entering"   (status "applying"): an opaque full-screen "A entrar em Hogwarts" with the seal.
const SKELETON_LINES = [["55%", "35%"], ["45%", "30%"]];

export default function Loading({ variant = "characters", exiting = false }) {
  if (variant === "entering") {
    return (
      <section className="loading-screen" aria-labelledby="entering-title" aria-busy="true">
        <div>
          <CtaSeal className="loading-screen__seal" />
          <h1 className="loading-screen__title" id="entering-title">A entrar em Hogwarts</h1>
          <div className="divider loading-screen__divider" aria-hidden="true"><Divider /></div>
          <p className="loading-screen__sub" role="status">A carregar a personagem. Aguarda um momento…</p>
          <div className="dots" aria-hidden="true"><i /><i /><i /></div>
        </div>
      </section>
    );
  }
  return (
    <Screen titleId="loading-title" title="A carregar as tuas personagens" subtitle="Aguarda um momento…" busy anchor={false}
      exiting={exiting} scrollHidden>
      <div className="char-list">
        {SKELETON_LINES.map(([first, second]) => (
          // Skeleton takes no children, so the card shell is the same markup with the same classes.
          <div key={first} className="skeleton skeleton-card skeleton-char" aria-hidden="true">
            <Skeleton className="skeleton--raised skeleton-char__crest" />
            <span className="skeleton-char__text">
              <Skeleton variant="line" className="skeleton--raised" style={{ width: first }} />
              <Skeleton variant="line" className="skeleton--raised" style={{ width: second }} />
            </span>
            <Skeleton className="skeleton--raised skeleton-char__action" />
          </div>
        ))}
      </div>
    </Screen>
  );
}
