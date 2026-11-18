import FrameCorner from "./ornaments/FrameCorner.jsx";

// Positioned box with the four engraved corner ornaments (STORY-05.02) drawn inside its border.
// `as` picks the element ("div" by default); extra props go to it.
export default function Frame({ as: Tag = "div", className = "", children, ...props }) {
  return (
    <Tag className={`frame ${className}`.trim()} {...props}>
      {["tl", "tr", "bl", "br"].map(position => (
        <span key={position} className={`corner corner--${position}`} aria-hidden="true"><FrameCorner /></span>
      ))}
      {children}
    </Tag>
  );
}
