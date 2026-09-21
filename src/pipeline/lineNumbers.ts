import { inkThreshold, luminance, type Rect } from "./imageUtils";
import type { MarginBounds } from "./margins";
import { normalizedCrossCorrelation, type GlyphAtlas } from "./match";

/**
 * Reading the line number margin.
 *
 * The margin is not the text area and cannot be read like it. Its font is a
 * separate setting, so on a machine where it was never matched to the text's
 * face its advance width is some other number, and slicing it at the text's
 * cell width lands between digits. What the margin does have, whatever face it
 * is in, is ink in the shape of digits: bands of it, one per digit, sitting on
 * the same baseline. So the digits are found by where the ink is, and read by
 * their shape alone - each one scaled to a common size before it is compared,
 * so a narrow face and a wide one ask the same question.
 */

/** Size every digit - found or template - is normalised to before comparison. */
const NORM_WIDTH = 16;
const NORM_HEIGHT = 28;

/** A band this much wider than a typical digit holds more than one, touching. */
const MERGED_DIGIT_RATIO = 1.5;

/** Confidence given to a row whose reading the numbering disagreed with. */
const DISPUTED_CONFIDENCE = 0.2;

const DIGITS = "0123456789";

export interface RowNumber {
  /** Whether the margin had anything on this row at all. */
  hasNumber: boolean;
  /** The fitted number; NaN where the row has none. */
  value: number;
  confidence: number;
}

/**
 * Reads every row's line number, and then makes them agree.
 *
 * Numbered rows are consecutive lines, so each one's reading implies what the
 * first of them was, and the reading they mostly agree on is right even where
 * an individual digit was misread. A row that disagrees keeps the fitted number
 * and loses its confidence, which is the useful way round: a number that is
 * merely wrong costs one row, while a number that is missed entirely makes its
 * row a continuation and glues a whole line onto the one above.
 */
export function readLineNumbers(
  image: ImageData,
  margins: MarginBounds,
  atlas: GlyphAtlas,
  rows: Array<{ top: number; bottom: number }>
): RowNumber[] {
  const shapes = digitShapes(atlas);
  const bands = rows.map((row) => gutterInk(image, margins, row));

  // One digit's width, from every band on screen rather than the two or three
  // on any one row.
  const widths = bands.flatMap((band) => band?.runs.map((r) => r.end - r.start) ?? []);
  const typicalWidth = widths.length > 0 ? median(widths) : 0;

  const readings = bands.map((band) =>
    band && typicalWidth > 0 ? readDigits(band, typicalWidth, shapes) : null
  );

  return fitNumbering(readings);
}

interface Band {
  /** Grayscale of the margin over one row, and its dimensions. */
  pixels: Float32Array;
  width: number;
  height: number;
  threshold: number;
  runs: Array<{ start: number; end: number }>;
}

/** The margin's ink over one row: the pixels, and the columns that have any. */
function gutterInk(image: ImageData, margins: MarginBounds, row: { top: number; bottom: number }): Band | null {
  const x0 = Math.max(0, Math.round(margins.gutterLeftX));
  const x1 = Math.min(image.width, Math.round(margins.gutterRightEdgeX));
  const y0 = Math.max(0, Math.round(row.top), Math.ceil(margins.bodyTopY));
  const y1 = Math.min(image.height, Math.round(row.bottom), Math.floor(margins.bodyBottomY));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 2 || height < 2) return null;

  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((y0 + y) * image.width + (x0 + x)) * 4;
      pixels[y * width + x] = luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
  }

  const threshold = inkThreshold(Array.from(pixels));

  const inked: boolean[] = [];
  for (let x = 0; x < width; x++) {
    let any = false;
    for (let y = 0; y < height && !any; y++) {
      if (pixels[y * width + x] <= threshold) any = true;
    }
    inked.push(any);
  }

  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let x = 0; x < width; x++) {
    if (inked[x] && start === -1) start = x;
    else if (!inked[x] && start !== -1) {
      runs.push({ start, end: x });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ start, end: width });

  return runs.length === 0 ? null : { pixels, width, height, threshold, runs };
}

/** Reads one row's digits from its bands of ink. */
function readDigits(
  band: Band,
  typicalWidth: number,
  shapes: Map<string, Float32Array>
): { value: number; confidence: number } | null {
  const digits: string[] = [];
  const scores: number[] = [];

  for (const run of band.runs) {
    // Blur closes the gap between two digits often enough that a band has to be
    // allowed to hold more than one - but only a band clearly wider than one
    // digit, since digits differ in width and a 1 is much narrower than a 0.
    const span = run.end - run.start;
    const count = span > typicalWidth * MERGED_DIGIT_RATIO ? Math.max(1, Math.round(span / typicalWidth)) : 1;
    const step = (run.end - run.start) / count;

    for (let k = 0; k < count; k++) {
      const shape = normalise(band, {
        x: Math.round(run.start + k * step),
        y: 0,
        w: Math.max(1, Math.round(step)),
        h: band.height,
      });
      if (!shape) continue;

      let best = "";
      let bestScore = -Infinity;
      for (const [char, template] of shapes) {
        const score = normalizedCrossCorrelation(shape, template);
        if (score > bestScore) {
          bestScore = score;
          best = char;
        }
      }
      if (best === "") continue;
      digits.push(best);
      scores.push((bestScore + 1) / 2);
    }
  }

  if (digits.length === 0) return null;
  return {
    value: parseInt(digits.join(""), 10),
    confidence: scores.reduce((a, b) => a + b, 0) / scores.length,
  };
}

/**
 * Crops a region to the ink in it and scales that to a common size.
 *
 * Scaling to the ink rather than to a cell is what makes the reading
 * independent of the margin's font: every digit in every face is the same
 * height, sitting on the same baseline, so its ink is the part worth comparing.
 */
function normalise(band: Band, region: Rect): Float32Array | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      if (x < 0 || x >= band.width || y < 0 || y >= band.height) continue;
      if (band.pixels[y * band.width + x] <= band.threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX || minY > maxY) return null;

  return resample(band.pixels, band.width, band.height, { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
}

/** The digit templates, each cropped to its own ink and scaled the same way. */
function digitShapes(atlas: GlyphAtlas): Map<string, Float32Array> {
  const shapes = new Map<string, Float32Array>();

  for (const char of DIGITS) {
    const glyph = atlas.glyphs.get(char);
    if (!glyph) continue;

    let min = Infinity;
    let max = -Infinity;
    for (const v of glyph) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const threshold = min + (max - min) * 0.5;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < atlas.cellHeight; y++) {
      for (let x = 0; x < atlas.cellWidth; x++) {
        if (glyph[y * atlas.cellWidth + x] <= threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (minX > maxX) continue;

    shapes.set(
      char,
      resample(glyph, atlas.cellWidth, atlas.cellHeight, {
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
      })
    );
  }
  return shapes;
}

/** Bilinear resample of a region of a single-channel buffer to the normalised size. */
function resample(source: Float32Array, width: number, height: number, region: Rect): Float32Array {
  const out = new Float32Array(NORM_WIDTH * NORM_HEIGHT);
  for (let y = 0; y < NORM_HEIGHT; y++) {
    for (let x = 0; x < NORM_WIDTH; x++) {
      const sx = region.x + ((x + 0.5) * region.w) / NORM_WIDTH;
      const sy = region.y + ((y + 0.5) * region.h) / NORM_HEIGHT;
      const ix = Math.min(width - 1, Math.max(0, Math.floor(sx)));
      const iy = Math.min(height - 1, Math.max(0, Math.floor(sy)));
      out[y * NORM_WIDTH + x] = source[iy * width + ix];
    }
  }
  return out;
}

/**
 * Makes the readings agree: every numbered row votes for what the first one
 * was, and the majority carries.
 */
export function fitNumbering(readings: Array<{ value: number; confidence: number } | null>): RowNumber[] {
  const votes = new Map<number, number>();
  let numbered = 0;
  const indices: number[] = [];

  readings.forEach((reading) => {
    if (!reading) {
      indices.push(-1);
      return;
    }
    indices.push(numbered);
    if (Number.isFinite(reading.value)) {
      const start = reading.value - numbered;
      votes.set(start, (votes.get(start) ?? 0) + 1);
    }
    numbered++;
  });

  let winner: number | null = null;
  let best = 0;
  for (const [start, count] of votes) {
    if (count > best) {
      best = count;
      winner = start;
    }
  }

  return readings.map((reading, row) => {
    if (!reading) return { hasNumber: false, value: NaN, confidence: 0 };

    const index = indices[row];
    if (winner === null) return { hasNumber: true, value: reading.value, confidence: reading.confidence };

    const fitted = winner + index;
    const agreed = reading.value === fitted;
    return {
      hasNumber: true,
      value: fitted,
      confidence: agreed ? reading.confidence : Math.min(reading.confidence, DISPUTED_CONFIDENCE),
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
