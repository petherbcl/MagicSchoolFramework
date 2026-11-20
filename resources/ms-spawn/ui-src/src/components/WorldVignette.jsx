// World vignette (handoff §1): a fixed, decorative layer of night-blue gradients over the game world. Only
// gradients and opacity (never backdrop-filter). `variant`: "spawn" | null (no variant).
const VARIANTS = Object.freeze(["spawn"]);

export default function WorldVignette({ variant = null }) {
  const modifier = VARIANTS.includes(variant) ? ` world-vignette--${variant}` : "";
  return <div className={`world-vignette${modifier}`} aria-hidden="true" />;
}
