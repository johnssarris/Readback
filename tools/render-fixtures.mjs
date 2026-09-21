/**
 * Renders stand-in "Notepad++ screenshots" for the pipeline metrics harness.
 *
 * These are a placeholder for the real thing. Chromium and the canvas-rendered
 * glyph atlas share a rasterizer, so a Chromium-rendered fixture flatters a
 * canvas atlas and can't be used to compare atlas sources. Every fixture this
 * produces is marked `"kind": "render"`, and the harness reports its numbers as
 * geometry-only: margins, cell pitch, row detection, blank-cell segmentation.
 *
 * Real Notepad++ screenshots (kind "screenshot") and phone photos (kind "photo")
 * drop into tests/fixtures/ alongside these and are measured by the same code.
 * See tests/fixtures/README.md.
 *
 * Usage: node tools/render-fixtures.mjs
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const fixtures = join(repo, "tests", "fixtures");

/** Plain view's own settings, mirrored here so a fixture looks like what the script produces. */
const PAPER = "#ffffff";
const INK = "#000000";
const GUTTER = "#e0e0e0"; // plain_view.py's GUTTER default
const CHROME = "#3c3c3c"; // menu/tab/status bars: the theme's, not Scintilla's

const CASES = [
  { name: "code-19px", source: "sample-code.txt", fontPx: 19, lineHeight: 23, width: 900, height: 620 },
  { name: "code-26px", source: "sample-code.txt", fontPx: 26, lineHeight: 32, width: 1180, height: 820 },
];

const fontDataUrl = (() => {
  const buf = readFileSync(join(repo, "public", "fonts", "cascadia-mono-latin-400-normal.woff2"));
  return `data:font/woff2;base64,${buf.toString("base64")}`;
})();

/**
 * Lays out text the way a monospace editor does — every character at its own
 * cell origin — so the fixture's true cell pitch is known exactly, rather than
 * being whatever the text shaper decided.
 */
function pageSource() {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c"></canvas>
<script>
window.render = async (opts) => {
  const face = new FontFace("CascadiaMono", \`url(\${opts.fontDataUrl})\`);
  await face.load();
  document.fonts.add(face);
  await document.fonts.ready;
  if (!document.fonts.check(\`\${opts.fontPx}px CascadiaMono\`)) {
    throw new Error("Cascadia Mono did not load in the renderer");
  }

  const c = document.getElementById("c");
  c.width = opts.width;
  c.height = opts.height;
  const ctx = c.getContext("2d");
  ctx.font = \`\${opts.fontPx}px CascadiaMono\`;
  ctx.textBaseline = "alphabetic";

  const advance = ctx.measureText("M").width;
  const metrics = ctx.measureText("Mgjpq");
  const ascent = metrics.actualBoundingBoxAscent;
  const descent = metrics.actualBoundingBoxDescent;

  const lines = opts.text.split("\\n");
  const digits = String(lines.length).length;
  // Notepad++ sizes the line number margin to fit the widest number, plus padding.
  const gutterPad = Math.round(advance * 0.6);
  const gutterRightEdgeX = Math.round(gutterPad * 2 + digits * advance);

  const chromeTop = Math.round(opts.lineHeight * 2.2);   // menu bar + tab bar
  const chromeBottom = Math.round(opts.lineHeight * 1.3); // status bar
  const bodyTopY = chromeTop;
  const bodyBottomY = opts.height - chromeBottom;

  ctx.fillStyle = "${CHROME}";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "${PAPER}";
  ctx.fillRect(0, bodyTopY, c.width, bodyBottomY - bodyTopY);
  ctx.fillStyle = "${GUTTER}";
  ctx.fillRect(0, bodyTopY, gutterRightEdgeX, bodyBottomY - bodyTopY);

  // Baseline placement inside the line box, same for gutter and text.
  const leading = opts.lineHeight - (ascent + descent);
  const baselineOffset = leading / 2 + ascent;

  const rowYCenters = [];
  ctx.fillStyle = "${INK}";
  lines.forEach((line, i) => {
    const rowTop = bodyTopY + i * opts.lineHeight;
    if (rowTop + opts.lineHeight > bodyBottomY) return;
    const baseline = rowTop + baselineOffset;
    rowYCenters.push(rowTop + opts.lineHeight / 2);

    const number = String(i + 1);
    for (let k = 0; k < number.length; k++) {
      // Right-aligned against the inner edge of the margin.
      const x = gutterRightEdgeX - gutterPad - (number.length - k) * advance;
      ctx.fillText(number[k], x, baseline);
    }
    for (let col = 0; col < line.length; col++) {
      const x = gutterRightEdgeX + col * advance;
      if (x > c.width) break;
      ctx.fillText(line[col], x, baseline);
    }
  });

  return {
    dataUrl: c.toDataURL("image/png"),
    truth: {
      cellWidthPx: advance,
      cellHeightPx: opts.lineHeight,
      bodyTopY,
      bodyBottomY,
      gutterRightEdgeX,
      textAreaLeftX: gutterRightEdgeX,
      rowCount: rowYCenters.length,
      rowYCenters,
      fontPx: opts.fontPx,
    },
  };
};
</script></body>`;
}

const browser = await chromium.launch({
  // The environment ships a Chromium build that may not match this Playwright
  // version's expected revision; point at the installed one rather than downloading.
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage();
await page.setContent(pageSource());

for (const spec of CASES) {
  const text = readFileSync(join(fixtures, spec.source), "utf8").replace(/\n$/, "");
  const result = await page.evaluate(
    (opts) => window.render(opts),
    { ...spec, text, fontDataUrl }
  );

  const png = Buffer.from(result.dataUrl.split(",")[1], "base64");
  writeFileSync(join(fixtures, `${spec.name}.png`), png);
  writeFileSync(
    join(fixtures, `${spec.name}.json`),
    JSON.stringify(
      {
        kind: "render",
        text: spec.source,
        note: "Chromium-rendered stand-in. Geometry metrics only - not valid for atlas comparison.",
        truth: result.truth,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`${spec.name}.png  ${result.truth.rowCount} rows, cell ${result.truth.cellWidthPx.toFixed(2)}x${result.truth.cellHeightPx}px`);
}

await browser.close();
