import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages serves this project at https://<user>.github.io/Readback/, so every
// asset URL has to be prefixed. Override with BASE_PATH=/ for a custom domain.
const base = process.env.BASE_PATH ?? "/Readback/";

/** Short commit of the build, so a phone can report exactly what it is running. */
function commitHash(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

const buildDate = new Date().toISOString().slice(0, 10);

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(commitHash()),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  plugins: [
    VitePWA({
      // "prompt" keeps the running app on its current version until the user
      // accepts the update, instead of swapping code under a live capture.
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Readback",
        short_name: "Readback",
        description: "Point the camera at a screen and read the text back",
        start_url: base,
        scope: base,
        display: "standalone",
        orientation: "portrait",
        background_color: "#111418",
        theme_color: "#111418",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // The glyph atlas is an optional, manually generated artifact; don't fail
        // the build or the install when it isn't checked in.
        globPatterns: ["**/*.{js,css,html,svg,png,json}"],
      },
    }),
  ],
});
