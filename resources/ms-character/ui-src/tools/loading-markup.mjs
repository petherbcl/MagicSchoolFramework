// Regression check for STORY-05.08: the markup of every Loading variant must not change when it is refactored.
//   node ui-src/tools/loading-markup.mjs          compares with ui-src/tools/loading-markup.snapshot.json
//   node ui-src/tools/loading-markup.mjs --write  rewrites the snapshot (only when the markup change is intended)
// Renders the real components with react-dom/server through Vite's SSR loader; it needs ui-src/node_modules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// bridge.js (pulled in through Screen) reads window at import time: a bare stub is enough, nothing here is interactive.
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { search: "" } };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotFile = path.join(root, "tools", "loading-markup.snapshot.json");
const server = await createServer({ root, configFile: false, plugins: [react()], server: { middlewareMode: true }, ssr: { external: ["react", "react-dom"] }, appType: "custom", logLevel: "error" });
try {
  const Loading = (await server.ssrLoadModule("/src/components/Loading.jsx")).default;
  const Cover = (await server.ssrLoadModule("/src/components/LoadingCover.jsx")).default;
  const html = props => renderToStaticMarkup(React.createElement(Loading, props));
  const actual = { entering: html({ variant: "entering" }), characters: html({ variant: "characters" }), charactersExiting: html({ variant: "characters", exiting: true }),
    // LoadingCover with every prop (the shape ms-spawn copies): extra class, h2, aria-busy off.
    coverOptions: renderToStaticMarkup(React.createElement(Cover, { title: "T", sub: "S", busy: false, className: "spawn-cover is-on", titleId: "x", heading: "h2" })) };
  if (process.argv.includes("--write")) { fs.writeFileSync(snapshotFile, JSON.stringify(actual, null, 2) + "\n"); console.log("snapshot written"); }
  else {
    const expected = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    let bad = 0;
    for (const key of Object.keys({ ...expected, ...actual })) if (expected[key] !== actual[key]) { bad++; console.error("DIFFERENT: " + key + "\n  expected: " + expected[key] + "\n  actual:   " + actual[key]); }
    if (bad) process.exitCode = 1; else console.log("Loading markup identical to the snapshot (" + Object.keys(actual).length + " variants)");
  }
} finally { await server.close(); }
