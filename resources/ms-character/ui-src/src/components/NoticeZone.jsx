import IconAlert from "./icons/IconAlert.jsx";

// "What happened. How to fix it." The first sentence (what happened) is bold ember, the rest is normal text.
export function splitNotice(text) {
  const match = /^(.+?[.!?…])(?:\s+([\s\S]+))?$/.exec(text.trim());
  return match ? { what: match[1], how: match[2] || "" } : { what: text.trim(), how: "" };
}

// The role="alert" zone is rendered from the first render, empty, so that screen readers announce the text
// when it is injected later. `variant` is "error" (ember) or "info" (arcane).
export default function NoticeZone({ text, variant = "error", className = "" }) {
  const { what, how } = text ? splitNotice(text) : {};
  return (
    <div role="alert" className={`notice-zone ${className}`.trim()}>
      {text ? (
        <div className={`notice${variant === "info" ? " notice--info" : ""}`}>
          <IconAlert />
          <p><strong>{what}</strong>{how ? ` ${how}` : ""}</p>
        </div>
      ) : null}
    </div>
  );
}
