import { useDragRotate } from "./RotateControl.jsx";

// Reserves the right half of the screen for the character the game draws (Rev. 2.1: it neither measures nor
// sends rectangles; the camera shift is the client's). Always empty and transparent, never rendered while loading.
// Dragging over it turns the character (CreatorPreview.rotate).
export default function AvatarAnchor() {
  return <div data-avatar-anchor aria-hidden="true" {...useDragRotate()} />;
}
