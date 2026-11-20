import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The CEF page is served from fw://resources/ms-spawn/client/ui/. Module scripts with
// `crossorigin` over a custom scheme are a CORS risk, so the bundle is a classic IIFE loaded
// with `defer`, exactly like the hand-written page it replaces. The CSP stays 'self'-only.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'";
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

// dev:ui only: serves the placeholder images of src/dev/icons/ as /icons/dev-*.svg so the mocked locations can show them.
// `apply: "serve"` means nothing of it, and none of those files, reaches the build (client/ui/icons/ comes from public/icons/).
const DEV_ICONS = fileURLToPath(new URL("./src/dev/icons/", import.meta.url));
function devIcons() {
  return {
    name: "ms-dev-icons",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/icons", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0].slice(1));
        if (!/^dev-[a-z0-9_-]+\.svg$/.test(name) || !existsSync(DEV_ICONS + name)) return next();
        res.setHeader("Content-Type", "image/svg+xml");
        createReadStream(DEV_ICONS + name).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), classicScripts(), devIcons()],
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
