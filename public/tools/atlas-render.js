/**
 * Glyph atlas rendering, shared by the generator page (public/tools/atlas-generator.html)
 * and the headless generator (tools/generate-atlas.mjs), so there is one definition of
 * what the atlas is and both produce the same bytes.
 *
 * The atlas is templates for a cell matcher: every cell of a photographed editor is
 * resampled to one atlas cell and correlated against all of them. The font here has to be
 * the font on the screen being photographed, which is why it is bundled rather than
 * assumed - iOS has no Cascadia Mono, and a silent fallback to some other monospace
 * would produce an atlas that matches nothing.
 */

/** The one place the atlas's font is named. Everything else reads it from here or from the manifest. */
export const ATLAS_FONT = {
  /** What the font is, for the manifest and for the setup instructions in plain_view.py. */
  name: "Cascadia Mono",
  /** Internal family name for the FontFace we register; never a system lookup. */
  family: "CascadiaMonoAtlas",
  /** Bundled woff2, relative to public/tools/. Ships with Windows 11, OFL-licensed. */
  url: "../fonts/cascadia-mono-latin-400-normal.woff2",
  /** Render size. Large enough that resampling down to a photographed cell loses nothing. */
  fontSize: 48,
};

/** The 95 printable ASCII characters, 0x20-0x7E. */
export const CHARS = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));

const COLS = 10;

/**
 * Registers the atlas font and proves it is really the one being used.
 *
 * A missing font doesn't throw on its own - canvas quietly falls back to some other
 * monospace and renders a perfectly convincing atlas of the wrong glyphs - so this
 * checks explicitly and refuses to continue.
 */
export async function loadAtlasFont(doc, { url = ATLAS_FONT.url, family = ATLAS_FONT.family } = {}) {
  const face = new FontFace(family, `url(${url})`);
  await face.load();
  doc.fonts.add(face);
  await doc.fonts.ready;

  if (!doc.fonts.check(`${ATLAS_FONT.fontSize}px ${family}`)) {
    throw new Error(`Atlas font ${family} failed to load from ${url}; refusing to render a fallback font`);
  }
  return family;
}

/** Font metrics the atlas geometry is built from, measured from the loaded face. */
export function measureFont(ctx, family, fontSize) {
  ctx.font = `${fontSize}px ${family}`;
  const m = ctx.measureText("M");
  const advance = m.width;
  if (!(advance > 0)) {
    throw new Error(`Atlas font ${family} measured a zero advance width`);
  }
  return {
    advance,
    ascent: m.fontBoundingBoxAscent,
    descent: m.fontBoundingBoxDescent,
  };
}

/**
 * Draws every glyph into `canvas` and returns the manifest describing it.
 *
 * Each glyph sits centered in a fixed cell.
 */
export function renderAtlas(canvas, options = {}) {
  const family = options.family ?? ATLAS_FONT.family;
  const fontSize = options.fontSize ?? ATLAS_FONT.fontSize;
  const cellWidth = options.cellWidth ?? 40;
  const cellHeight = options.cellHeight ?? 64;

  const rows = Math.ceil(CHARS.length / COLS);
  canvas.width = cellWidth * COLS;
  canvas.height = cellHeight * rows;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = `${fontSize}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000000";

  const sprites = {};
  CHARS.forEach((ch, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    ctx.fillText(ch, col * cellWidth + cellWidth / 2, row * cellHeight + cellHeight / 2);
    sprites[ch] = { x: col * cellWidth, y: row * cellHeight, w: cellWidth, h: cellHeight };
  });

  assertRendered(ctx, sprites);

  return {
    font: ATLAS_FONT.name,
    fontFamily: family,
    cellWidth,
    cellHeight,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    fontSize,
    sprites,
  };
}

/**
 * Catches an atlas of nothing: a font that loaded but drew blanks, a zero-size cell,
 * a canvas that silently failed. "M" must have ink and " " must not.
 */
export function assertRendered(ctx, sprites) {
  const inked = (rect) => {
    const { data } = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 128) return true;
    }
    return false;
  };

  if (!inked(sprites["M"])) {
    throw new Error("Atlas rendered no ink for 'M' - the font did not draw");
  }
  if (inked(sprites[" "])) {
    throw new Error("Atlas rendered ink for the space character - the cells are misaligned");
  }
}
