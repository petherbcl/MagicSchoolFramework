// D8 world vignette (handoff §11): a fixed, decorative layer of night-blue gradients over the game world.
// Rendered once by App, outside the screens, so it is not recreated on every screen change. Only gradients
// and opacity (never backdrop-filter). `variant`: "lobby" | "creator" | "loading" | null (no variant).
const VARIANTS = Object.freeze(["lobby", "creator", "loading"]);

export default function WorldVignette({ variant = null }) {
  const modifier = VARIANTS.includes(variant) ? ` world-vignette--${variant}` : "";
  return <div className={`world-vignette${modifier}`} aria-hidden="true" />;
}
