// Location icon images (CHG-05, handoff §10.6 and §10.7). Module-level memory so a re-render or a remount of the list
// never flashes pin -> image: the load result is remembered per FILE NAME for the whole page session.
//
// The server already validates `icon` (STORY-01.08) and never sends one for "last"; the page validates again and only
// ever builds `icons/<validated name>` (same origin, CSP img-src 'self').
const ICON_NAME = /^[a-z0-9_-]+\.(png|webp|jpg|jpeg|svg)$/;
const MAX_NAME = 64;

export const isValidIconName = name => typeof name === "string" && name.length <= MAX_NAME && ICON_NAME.test(name);
export const iconUrl = name => "icons/" + name; // callers pass a validated name only

const results = new Map(); // file name -> "ok" | "fail"
const warned = new Set(); // file names (or invalid values) already reported with console.warn

export const iconResult = name => results.get(name) ?? "loading";
export function rememberIcon(name, result) {
  results.set(name, result);
  if (result === "fail") warnOnce(name, "image failed to load");
}

// One console.warn per file name per page session (architect decision, G28). No UI, no player message. A bad value is
// truncated and JSON-quoted so it can never forge extra log lines.
export function warnOnce(name, reason) {
  const key = typeof name === "string" ? name.slice(0, MAX_NAME) : String(name);
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[ms-spawn] icon ${JSON.stringify(key)}: ${reason}`);
}
