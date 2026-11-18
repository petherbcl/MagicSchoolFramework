// Loading placeholder with a translateX shimmer (1.4 s). Decorative: the busy state is announced by the
// parent (aria-busy). `variant`: "card" | "line" | "circle" | "block"; size via `style` or `className`.
const VARIANTS = Object.freeze({ card: "skeleton-card", line: "skeleton-line", circle: "skeleton-circle", block: "" });

export default function Skeleton({ variant = "block", className = "", style }) {
  return <span aria-hidden="true" className={`skeleton ${VARIANTS[variant] ?? ""} ${className}`.trim()} style={style} />;
}
