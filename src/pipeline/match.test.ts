import { describe, expect, it } from "vitest";
import { buildAtlasFromImageData, matchCell, normalizedCrossCorrelation, type AtlasManifest } from "./match";
import { soften } from "./imageUtils";

const SIZE = 8;

/** 0 = black ink, 255 = white background, laid out row-major. */
function drawPattern(pattern: number[]): Float32Array {
  return Float32Array.from(pattern);
}

// A vertical stripe down the middle two columns.
const STRIPE = drawPattern(
  [0, 1, 2, 3, 4, 5, 6, 7].flatMap(() => [255, 255, 255, 0, 0, 255, 255, 255])
);

// A hollow ring (border dark, interior light).
const RING = drawPattern(
  Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) => {
      const isBorder = x === 0 || x === SIZE - 1 || y === 0 || y === SIZE - 1;
      return isBorder ? 0 : 255;
    })
  ).flat()
);

// A single dark dot near the bottom-center.
const DOT = drawPattern(
  Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) => (y >= 5 && y <= 6 && x >= 3 && x <= 4 ? 0 : 255))
  ).flat()
);

const BLANK = drawPattern(new Array(SIZE * SIZE).fill(255));

// High contrast, but nothing like any of the glyphs above.
const CHECKER = drawPattern(
  Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) => ((x + y) % 2 === 0 ? 0 : 255))
  ).flat()
);

/** A blank cell as a photograph gives it: uniform page, plus a little sensor noise. */
const NOISY_BLANK = drawPattern(
  Array.from({ length: SIZE * SIZE }, (_, i) => 232 + ((i * 7) % 5))
);

/** Packs one or more named grayscale patterns side-by-side into a single ImageData + manifest. */
function buildTestAtlasImage(patterns: Record<string, Float32Array>): { image: ImageData; manifest: AtlasManifest } {
  const chars = Object.keys(patterns);
  const width = SIZE * chars.length;
  const height = SIZE;
  const data = new Uint8ClampedArray(width * height * 4);

  const sprites: AtlasManifest["sprites"] = {};
  chars.forEach((char, index) => {
    const offsetX = index * SIZE;
    const pattern = patterns[char];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const gray = pattern[y * SIZE + x];
        const i = (y * width + (offsetX + x)) * 4;
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        data[i + 3] = 255;
      }
    }
    sprites[char] = { x: offsetX, y: 0, w: SIZE, h: SIZE };
  });

  const image = { width, height, data, colorSpace: "srgb" } as ImageData;
  const manifest: AtlasManifest = {
    cellWidth: SIZE,
    cellHeight: SIZE,
    canvasWidth: width,
    canvasHeight: height,
    fontSize: SIZE,
    sprites,
  };
  return { image, manifest };
}

/** Wraps a single pattern as a standalone ImageData to be matched against. */
function patternAsImage(pattern: Float32Array): ImageData {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = pattern[i];
    data[i * 4 + 1] = pattern[i];
    data[i * 4 + 2] = pattern[i];
    data[i * 4 + 3] = 255;
  }
  return { width: SIZE, height: SIZE, data, colorSpace: "srgb" } as ImageData;
}

describe("normalizedCrossCorrelation", () => {
  it("returns 1 for identical buffers", () => {
    expect(normalizedCrossCorrelation(STRIPE, STRIPE)).toBeCloseTo(1, 5);
  });

  it("returns 0 for a flat (zero-variance) buffer", () => {
    expect(normalizedCrossCorrelation(BLANK, STRIPE)).toBe(0);
  });
});

describe("matchCell", () => {
  it("confidently matches a cell identical to one distinct atlas glyph", () => {
    const { image: atlasImage, manifest } = buildTestAtlasImage({ I: STRIPE, O: RING, ".": DOT });
    const atlas = buildAtlasFromImageData(atlasImage, manifest);

    const cellImage = patternAsImage(STRIPE);
    const result = matchCell(cellImage, { x: 0, y: 0, w: SIZE, h: SIZE }, atlas);

    expect(result.char).toBe("I");
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.flagged).toBe(false);
  });

  it("flags a cell as ambiguous when two atlas glyphs tie", () => {
    const { image: atlasImage, manifest } = buildTestAtlasImage({ I: STRIPE, l: STRIPE, O: RING });
    const atlas = buildAtlasFromImageData(atlasImage, manifest);

    const cellImage = patternAsImage(STRIPE);
    const result = matchCell(cellImage, { x: 0, y: 0, w: SIZE, h: SIZE }, atlas);

    expect(result.flagged).toBe(true);
    expect(["I", "l"]).toContain(result.char);
  });

  it("flags a cell with no resemblance to any atlas glyph as unrecognized", () => {
    const { image: atlasImage, manifest } = buildTestAtlasImage({ I: STRIPE, O: RING, ".": DOT });
    const atlas = buildAtlasFromImageData(atlasImage, manifest);

    const cellImage = patternAsImage(CHECKER);
    const result = matchCell(cellImage, { x: 0, y: 0, w: SIZE, h: SIZE }, atlas);

    expect(result.flagged).toBe(true);
    expect(result.confidence).toBeLessThan(0.55);
  });

  it("reads a blank cell beside a wide neighbour as a space", () => {
    // Two cells side by side: the left one holds a glyph whose ink reaches its
    // own right edge and, blurred, a column or two into the cell beside it. The
    // right cell is empty, and has to read as empty.
    const width = SIZE * 2;
    const data = new Uint8ClampedArray(width * SIZE * 4);
    const bleed = [60, 230]; // what is left of the neighbour's ink, a column in
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < width; x++) {
        const gray = x < SIZE ? 0 : (bleed[x - SIZE] ?? 255);
        const i = (y * width + x) * 4;
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        data[i + 3] = 255;
      }
    }
    const scene = { width, height: SIZE, data, colorSpace: "srgb" } as ImageData;

    const { image: atlasImage, manifest } = buildTestAtlasImage({ "0": RING, " ": BLANK, I: STRIPE });
    const atlas = buildAtlasFromImageData(atlasImage, manifest);

    // Across the whole cell that fringe is 195 levels of contrast, well past the
    // blank threshold; across the middle of it, 25.
    const result = matchCell(scene, { x: SIZE, y: 0, w: SIZE, h: SIZE }, atlas);
    expect(result.char).toBe(" ");
  });

  it("reads a blank cell as a space rather than the first glyph in the atlas", () => {
    // Correlation can't decide this: a blank cell is flat, so every glyph scores
    // the same and the winner is whichever the atlas happens to list first - and
    // the space template is flat too, so it can never win on its own merits.
    const { image: atlasImage, manifest } = buildTestAtlasImage({ "0": RING, " ": BLANK, I: STRIPE });
    const atlas = buildAtlasFromImageData(atlasImage, manifest);

    for (const pattern of [BLANK, NOISY_BLANK]) {
      const result = matchCell(patternAsImage(pattern), { x: 0, y: 0, w: SIZE, h: SIZE }, atlas);
      expect(result.char).toBe(" ");
      expect(result.flagged).toBe(false);
    }
  });
});

describe("soften", () => {
  it("spreads a stroke without moving it or changing its total ink", () => {
    const w = 9;
    const h = 9;
    const src = new Float32Array(w * h).fill(255);
    for (let y = 0; y < h; y++) src[y * w + 4] = 0; // one dark column down the middle

    const out = soften(src, w, h, 1);

    // The darkest point stays where the stroke was, and its neighbours darken.
    const row = 4 * w;
    expect(out[row + 4]).toBeLessThan(out[row + 3]);
    expect(out[row + 3]).toBeLessThan(out[row + 2]);
    expect(out[row + 3]).toBeCloseTo(out[row + 5], 5); // symmetric

    // Nothing is created or destroyed: a blur redistributes, it does not darken.
    const total = (b: Float32Array) => b.reduce((a, v) => a + v, 0);
    expect(total(out) / total(src)).toBeGreaterThan(0.99);
    expect(total(out) / total(src)).toBeLessThan(1.01);
  });

  it("leaves the buffer alone at radius zero", () => {
    const src = new Float32Array([1, 2, 3, 4]);
    expect(soften(src, 2, 2, 0)).toBe(src);
  });
});
