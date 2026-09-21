/**
 * Builds public/atlas/ headlessly, from the same code the generator page uses.
 *
 * The page (public/tools/atlas-generator.html) is still there for rendering from
 * a locally installed font file; this is the reproducible path, and rebuilds the
 * same bytes every time.
 *
 * Usage: npm run atlas
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const publicDir = join(repo, "public");
const outDir = join(publicDir, "atlas");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

// Served rather than opened from disk: a module import over file:// is a
// cross-origin request, which the browser refuses.
const server = createServer((req, res) => {
  const path = join(publicDir, normalize(decodeURIComponent(req.url.split("?")[0])));
  if (!path.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    statSync(path);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage();

// Loaded from public/tools/ so the module's relative font URL resolves the same way
// it does when the generator page is served.
await page.goto(`${origin}/tools/atlas-generator.html`);

const result = await page.evaluate(async () => {
  const { ATLAS_FONT, loadAtlasFont, renderAtlas } = await import("./atlas-render.js");
  await loadAtlasFont(document);
  const canvas = document.createElement("canvas");
  const manifest = renderAtlas(canvas, { fontSize: ATLAS_FONT.fontSize });
  return { manifest, dataUrl: canvas.toDataURL("image/png") };
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "atlas.png"), Buffer.from(result.dataUrl.split(",")[1], "base64"));
writeFileSync(join(outDir, "atlas-manifest.json"), JSON.stringify(result.manifest, null, 2) + "\n");

const m = result.manifest;
console.log(
  `atlas: ${m.font} ${m.fontSize}px, ${Object.keys(m.sprites).length} glyphs, cell ${m.cellWidth}x${m.cellHeight}, sheet ${m.canvasWidth}x${m.canvasHeight}`
);

await browser.close();
server.close();
