import LoadingCover from "./LoadingCover.jsx";
import Screen from "./Screen.jsx";
import Skeleton from "./Skeleton.jsx";

// Loading screens (loading.html). Neither renders an AvatarAnchor.
//   variant "characters" (status "loading"): the lobby layout with two skeleton cards; the world vignette is the
//                        --loading variant (rendered by App). `exiting` plays the 150 ms exit when the lobby or
//                        the creator replaces it.
//   variant "world"      (lobby spawn, world still loading): the same opaque cover with its own texts.
//   variant "entering"   (status "applying"): an opaque full-screen "A entrar em Hogwarts" with the seal (LoadingCover).
const SKELETON_LINES = [["55%", "35%"], ["45%", "30%"]];

export default function Loading({ variant = "characters", exiting = false }) {
  if (variant === "world") {
    return <LoadingCover title="A preparar o mundo" sub="A carregar Hogwarts. Aguarda um momento…" titleId="world-title" />;
  }
  if (variant === "entering") {
    return <LoadingCover title="A entrar em Hogwarts" sub="A carregar a personagem. Aguarda um momento…" />;
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
