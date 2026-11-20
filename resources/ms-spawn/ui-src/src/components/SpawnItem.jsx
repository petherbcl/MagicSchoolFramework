import { useLayoutEffect, useReducer, useRef } from "react";
import IconCheck from "./icons/IconCheck.jsx";
import IconSpinner from "./icons/IconSpinner.jsx";
import IconStar from "./icons/IconStar.jsx";
import IconPin from "./IconPin.jsx";
import { iconResult, iconUrl, isValidIconName, rememberIcon, warnOnce } from "../iconCache.js";

// One location (handoff §3.3 and §10): a full-width toggle button, grid `icon slot · name · 1.5 rem slot`. Both slots have a
// fixed size so nothing moves between pin, image, spinner, check and empty.
//   kind      "last" (gold star + accent bar, never an image) or "config" (pin, or the image when `icon` is valid)
//   icon      file name only (from ms-spawn:open); the page loads `icons/<name>` after validating it
//   selected  aria-pressed. Selected is shown by border + glow AND by the check or the spinner, never by colour alone
//   flying    the camera is still flying / the area is still loading: spinner + progress line instead of the check
//   disabled  applying or session lost (the chosen item stays fully opaque)
// The pin/star is ALWAYS rendered under the image; the image and the ring fade in on load, and on error the <img> is removed.
export default function SpawnItem({ name, kind = "config", icon, selected = false, flying = false, disabled = false, onSelect }) {
  const isLast = kind === "last";
  const Icon = isLast ? IconStar : IconPin;
  const [, rerender] = useReducer(count => count + 1, 0);
  const imgRef = useRef(null);
  const wanted = !isLast && icon !== undefined && icon !== null && icon !== "";
  const valid = wanted && isValidIconName(icon);
  const state = valid ? iconResult(icon) : "none"; // "none" | "loading" | "ok" | "fail" (read from the module memory)
  const showImg = valid && state !== "fail";

  // A bad name never becomes a URL; it is reported once.
  useLayoutEffect(() => { if (wanted && !valid) warnOnce(icon, "invalid file name, ignored"); }, [wanted, valid, icon]);
  // Cached image: `load` may have fired before React attached onLoad, so read the element when it mounts or `icon` changes.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete || iconResult(icon) !== "loading") return;
    rememberIcon(icon, img.naturalWidth > 0 ? "ok" : "fail");
    rerender();
  }, [icon, showImg]);

  const settle = result => { rememberIcon(icon, result); rerender(); };
  return (
    <button type="button" className={`spawn-item${isLast ? " spawn-item--last" : ""}${flying ? " is-flying" : ""}`}
      aria-pressed={selected} disabled={disabled} onClick={onSelect}>
      <span className="spawn-item__media" data-img={state} aria-hidden="true">
        <Icon className="spawn-item__icon" />
        {showImg && <img ref={imgRef} className="spawn-item__img" src={iconUrl(icon)} alt="" width="72" height="72" decoding="async" draggable="false"
          onLoad={() => settle("ok")} onError={() => settle("fail")} />}
        <span className="spawn-item__ring" />
      </span>
      <span className="spawn-item__name">{name}</span>
      <span className="spawn-item__slot" aria-hidden="true">
        <IconSpinner className="spawn-item__spin" />
        <IconCheck className="spawn-item__check" />
      </span>
      <span className="spawn-item__progress" aria-hidden="true" />
    </button>
  );
}
