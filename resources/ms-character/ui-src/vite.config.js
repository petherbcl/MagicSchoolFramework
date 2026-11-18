import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The CEF page is served from fw://resources/ms-character/client/ui/. Module scripts with
// `crossorigin` over a custom scheme are a CORS risk, so the bundle is a classic IIFE loaded
// with `defer`, exactly like the hand-written page it replaces. The CSP stays 'self'-only.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";
function classicScripts() {
  return {
    name: "ms-classic-scripts",
    apply: "build", // The dev server needs inline styles and module scripts; the CSP applies to the game build.
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/<script type="module" crossorigin/g, "<script defer").replace(/ crossorigin/g, "")
        .replace('<meta charset="utf-8">', `<meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), classicScripts()],
  build: {
    outDir: "../client/ui",
    emptyOutDir: true,
    modulePreload: false,
    // One CSS file linked from index.html: JS-injected <style> tags would be blocked by style-src 'self'.
    cssCodeSplit: false,
    target: "chrome100",
    assetsDir: "assets",
    // Never inline assets as data: URIs (the font must ship as a file for font-src 'self').
    assetsInlineLimit: 0,
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
