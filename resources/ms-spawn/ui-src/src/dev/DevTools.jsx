import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockFlags, mockLose, mockOpen } from "../bridge.js";
import "./dev.css";

// `npm run dev:ui` only (see main.jsx): a fake bright world behind the page and the review toolbar of
// docs/design/mockups/spawn.html. Reaches every screen state of handoff §3.1 through the mocked server in bridge.js.
// Hash shortcuts as in the mockup (CHG-02): #cover-choosing (long cover over the choice), #cover-confirm (cover over the
// confirmation), #cover-fail (preparation failure), #cover-rapid (three selects 250 ms apart), plus #transit (flying),
// #arrived, #error, #empty, #lost. #loading-area = #cover-choosing and #applying = #cover-confirm, as in the mockup.
const TOGGLES = [
  ["last", "Última localização"],
  ["many", "12 locais"],
  ["slow", "Mundo a carregar"],
  ["fail", "Falha ao preparar"],
  ["reject", "Servidor rejeita"],
  ["empty", "Sem locais"],
];

function Toolbar({ startLost }) {
  const [flags, setFlags] = useState({ ...mockFlags });
  const [lost, setLost] = useState(startLost);
  const toggle = key => {
    mockFlags[key] = !mockFlags[key];
    setFlags({ ...mockFlags });
    setLost(false);
    if (key === "last" || key === "many" || key === "empty") mockOpen(); // the location list changes: a new "open"
  };
  const toggleLost = () => {
    if (lost) { setLost(false); mockOpen(); } else { setLost(true); mockLose(); }
  };
  return (
    <div className="dev-toolbar" role="group" aria-label="Controlos do protótipo">
      <span>Protótipo:</span>
      {TOGGLES.map(([key, label]) => <button key={key} type="button" aria-pressed={flags[key]} onClick={() => toggle(key)}>{label}</button>)}
      <button type="button" onClick={rapidSelect}>Re-seleção rápida</button>
      <button type="button" aria-pressed={lost} onClick={toggleLost}>Sessão perdida</button>
    </div>
  );
}

const pick = name => [...document.querySelectorAll(".spawn-item")].find(button => button.textContent.includes(name))?.click();
// Click the CTA as soon as it is active (the cover and the flight come first), giving up after 15 s.
const confirmWhenReady = () => {
  const started = Date.now();
  const poll = setInterval(() => {
    const cta = document.querySelector(".cta");
    if (cta && !cta.disabled) { clearInterval(poll); cta.click(); } else if (Date.now() - started > 15000) clearInterval(poll);
  }, 100);
};
// Three selects 250 ms apart (the cover must stay on and its text must not change). Like queued events: the panel is
// inert behind the cover for real users, so this is the only way to send them.
const rapidSelect = () => {
  const items = [...document.querySelectorAll(".spawn-item")].slice(0, 3);
  items.forEach((item, index) => setTimeout(() => item.click(), index * 250));
};

export default function mountDevTools() {
  const hash = location.hash.slice(1);
  // Flags first, so the toolbar and the first "open" (sent after the page handshake) already reflect the hash.
  if (hash === "empty") mockFlags.empty = true;
  if (hash === "cover-choosing" || hash === "loading-area") mockFlags.slow = true;
  if (hash === "cover-fail") mockFlags.fail = true;
  if (hash === "error") mockFlags.reject = true;

  const world = document.createElement("div");
  world.className = "dev-world";
  world.setAttribute("aria-hidden", "true");
  document.body.prepend(world);
  const host = document.createElement("div");
  document.body.append(host);
  createRoot(host).render(<Toolbar startLost={hash === "lost"} />);

  setTimeout(() => { // after the 200 ms mock handshake
    if (hash === "lost") mockLose();
    else if (hash === "transit") pick("Portões");
    else if (hash === "arrived") pick("Hogsmeade");
    else if (hash === "cover-choosing" || hash === "loading-area") pick("Feldcroft");
    else if (hash === "cover-fail") pick("Hogsmeade");
    else if (hash === "cover-rapid") rapidSelect();
    else if (hash === "cover-confirm" || hash === "applying" || hash === "error") { pick("Hogsmeade"); confirmWhenReady(); }
  }, 400);
  window.addEventListener("hashchange", () => location.reload());
}
