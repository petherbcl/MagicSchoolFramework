import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);

// `npm run dev:ui` only: fake world and review toolbar. The branch is dead code in the build, so Rollup drops the
// dynamic import and nothing from ./dev ships to the game.
if (import.meta.env.DEV) {
  import("./dev/DevTools.jsx").then(({ default: mountDevTools }) => mountDevTools());
}
