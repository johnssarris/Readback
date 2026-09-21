import { findRuns, luminance, median, otsuThreshold } from "./imageUtils";
import type { MarginBounds } from "./margins";

export interface CellPitch {
  widthPx: number;
  heightPx: number;
  /** Left edge of the first character cell, in full rectified-image coordinates. */
  columnOriginX: number;
  /** Vertical center (in full rectified-image coordinates) of each displayed row's line box. */
  rowYCenters: number[];
  /**
   * Text baseline of each row, taken from the feet of the line numbers and
   * carried across rows that have none (a wrapped continuation, or a row whose
   * number was too faint to find).
   */
  rowBaselines: number[];
}

/**
 * Plausible range for a monospace advance width, as a fraction of the line box.
 * Every common coding face sits near 0.5 (Cascadia Mono 0.50, Consolas 0.47,
 * JetBrains Mono 0.50, DejaVu Sans Mono 0.51), so this is generous - and being
 * narrower than 2x either way is what stops the estimator locking onto every
 * second column instead of every column.
 */
const MIN_ADVANCE_RATIO = 0.3;
const MAX_ADVANCE_RATIO = 0.8;

/** Candidate widths are swept this finely (px). Half a pixel of error is several cells of drift by column 100. */
const WIDTH_COARSE_STEP = 0.05;
const WIDTH_FINE_STEP = 0.005;

/** How far either side of the coarse width the sharper measure looks. */
const WIDTH_POLISH = 0.04;

/** Step (px) of the continuous sweep for the phase of a cell boundary. */
const PHASE_STEP = 0.1;

/** Width of the band read at each boundary, as a share of the cell. */
const BOUNDARY_BAND = 0.12;

/** Phase bins used to score a candidate width. */
const PHASE_BINS = 12;

/** Columns of text ink needed before the text area is worth measuring. */
const MIN_INK_COLUMNS = 12;

/** Inked pixels an image row needs before it counts as a row rather than noise. */
const MIN_ROW_INK = 2;

/**
 * Above this share of the body's width, a dark row is the window's own edge
 * rather than text. Even a dense line of code leaves most of its row as page;
 * the soft boundary where the body meets the chrome darkens all of it, and
 * would otherwise add a row past the end of the document.
 */
const MAX_ROW_INK_FRACTION = 0.6;

/** Most phase bins used to count the rows within one line's spacing. */
const ROW_PHASE_BINS = 32;

/** A wrapped line is taken to occupy at most this many rows. */
const MAX_ROWS_PER_LINE = 4;

/** Share of the busiest phase's ink that still counts as part of a row. */
const BAND_THRESHOLD = 0.15;

/** Share of a typical row's ink that separates a row with only a line number on it from noise. */
const MIN_ROW_INK_SHARE = 0.02;

/** Where in a row's own brightness the page colour is read, and how far below it ink sits. */
const PAGE_PERCENTILE = 0.75;
const INK_FRACTION_OF_PAGE = 0.55;

/**
 * A line number's ink is at least this tall, as a share of the line spacing -
 * cap height is well over half a line box in any face. Below it, a band is the
 * soft edge of the window chrome or a speck, and taking one as a row puts the
 * whole grid half a row out.
 */
const MIN_DIGIT_HEIGHT = 0.25;

/**
 * How far a row's box may hang outside the body before it stops being a row.
 * The first and last rows of a screenful sit right against the chrome and can
 * legitimately overhang it slightly; a "row" past the end of the document,
 * conjured by the soft edge where the body meets the chrome, hangs out by most
 * of its height.
 */
const MAX_ROW_OVERHANG = 0.25;

/** Fine sweep around the chosen pitch, and its step, in px. */
const PITCH_POLISH = 0.06;
const ROW_PITCH_STEP = 0.02;

/** Typical width/height ratio of a monospace cell; the last-resort seed when there is no text to measure. */
const ASSUMED_ASPECT_RATIO = 0.5;

/** Rows whose digit blob is narrower than this fraction of the seed cell width are treated as blank. */
const MIN_BLOB_WIDTH_FRACTION = 0.4;

/**
 * Derives the actual on-image character cell pitch from the capture itself,
 * rather than trusting screen-side font/DPI constants (see plan: Design decisions,
 * "Self-calibrating cell pitch").
 */
export function calibrateCellPitch(image: ImageData, margins: MarginBounds): CellPitch {
  const gutter = analyzeGutter(image, margins);
  const rows = detectRows(image, margins, gutter);

  const columns = fitColumns(image, margins, rows.pitch);
  const widthPx = columns?.width ?? gutter.widthFromDigits(rows.pitch * ASSUMED_ASPECT_RATIO);

  // Where the gutter's background ends is the editor's left margin, which is
  // where the first cell starts only if the theme adds no padding there. The
  // text's own boundaries say where the cells really are; the margin is only
  // consulted when there is not enough text to ask.
  const columnOriginX = columns
    ? firstColumnOrigin(columns.originX, widthPx, margins.textAreaLeftX)
    : margins.textAreaLeftX;

  return {
    widthPx,
    heightPx: rows.pitch,
    columnOriginX,
    rowYCenters: rows.centers,
    rowBaselines: rows.baselines,
  };

}

/**
 * Picks the cell boundary the first column starts at.
 *
 * The boundaries repeat every cell, so any one of them describes the same grid.
 * Which one is column zero is decided by the editor's left margin: the first
 * boundary at or after it. Taking the nearest one instead would put a boundary
 * inside the margin's padding whenever that padding is more than half a cell,
 * and every line would come back with a blank column in front of it.
 *
 * The margin itself is measured, so a boundary a hair to the left of it is the
 * same boundary; the width of a gap between characters is the natural slack.
 */
function firstColumnOrigin(originX: number, width: number, marginX: number): number {
  const steps = Math.ceil((marginX - width * BOUNDARY_BAND - originX) / width);
  return originX + steps * width;
}

/**
 * Finds the displayed rows from ink across the whole body, and fits a grid to them.
 *
 * Reading rows from the line numbers alone loses every row that hasn't got one:
 * with word wrap on, a wrapped continuation is numberless, so its text was never
 * read at all, and the gaps it left made the row spacing come out a multiple of
 * the truth. Ink anywhere on a row - a line number, text, either - marks a row
 * that exists.
 *
 * The rows are then fitted rather than used as found, so a row's box comes from
 * the grid the editor laid out and not from the shape of what happens to be on
 * it: a line of "aeo" has no ascenders and a line of "^^^" no baseline, but both
 * sit in the same box as every other.
 */
function detectRows(image: ImageData, margins: MarginBounds, gutter: GutterAnalysis): RowGrid {
  const profile = rowInkProfile(image, margins);
  const first = profile.findIndex((c) => c >= MIN_ROW_INK);
  if (first < 0 || gutter.digitRuns.length < 2 || !(gutter.cellHeightPx > 0)) {
    return fallbackGrid(gutter);
  }
  let last = profile.length - 1;
  while (last > first && profile[last] < MIN_ROW_INK) last--;

  const y0 = Math.max(0, Math.round(margins.bodyTopY));
  const pitch = rowPitch(profile, gutter.cellHeightPx);

  // The line numbers fix the grid's phase: enumerate rows from one of them,
  // outward, far enough to cover everything in the body that has ink on it -
  // which is how a wrapped continuation row, numberless by definition, gets a
  // row of its own instead of being skipped.
  const anchor = (gutter.digitRuns[0].start + gutter.digitRuns[0].end) / 2;
  const firstIndex = Math.ceil((y0 + first - anchor) / pitch - 0.5);
  const lastIndex = Math.floor((y0 + last - anchor) / pitch + 0.5);

  const overhang = pitch * MAX_ROW_OVERHANG;
  const candidates: number[] = [];
  for (let k = firstIndex; k <= lastIndex; k++) {
    const center = anchor + k * pitch;
    if (center - pitch / 2 < margins.bodyTopY - overhang) continue;
    if (center + pitch / 2 > margins.bodyBottomY + overhang) continue;
    candidates.push(center);
  }

  const centers = withInk(candidates, profile, y0, pitch);
  if (centers.length === 0) {
    return fallbackGrid(gutter);
  }

  return { pitch, centers, baselines: fitBaselines(gutter, centers[0], pitch, centers) };
}

/**
 * The row pitch, from the line numbers' spacing and how many rows fit in it.
 *
 * Line numbers are a line apart, which is a whole number of rows: one for a line
 * that fits, more for one the editor wrapped. Folding the body's ink onto its
 * phase within that spacing shows how many rows there are - one band of ink per
 * row - and the pitch is the spacing divided by however many come back.
 *
 * Counting bands rather than scoring candidate pitches matters: a pitch of half
 * a row divides the true one exactly, so it folds just as neatly and scores just
 * as well. Only the number of bands tells them apart.
 *
 * Taking the pitch from the ink alone would be worse again: at small font sizes
 * a photograph blurs one row's descenders into the next row's ascenders, and
 * rows that touch cannot be counted at all.
 */
function rowPitch(profile: number[], lineSpacing: number): number {
  const coarse = lineSpacing / rowsPerLine(profile, lineSpacing);

  // Polish: the line numbers' spacing is a median of whole-pixel measurements,
  // and a fraction of a pixel per row is a whole row by the bottom of a screenful.
  let refined = coarse;
  let refinedScore = -Infinity;
  for (let pitch = coarse * (1 - PITCH_POLISH); pitch <= coarse * (1 + PITCH_POLISH); pitch += ROW_PITCH_STEP) {
    // Same pairing as the cell width: the spread of the ink keeps the answer on
    // the right pitch, the gap between rows sharpens it.
    const score = emptiestPhase(profile, pitch).depth * periodicityScore(profile, pitch);
    if (score > refinedScore) {
      refinedScore = score;
      refined = pitch;
    }
  }
  return refined;
}

/** How many bands of ink fall within one line's spacing: one per displayed row. */
function rowsPerLine(profile: number[], lineSpacing: number): number {
  // Never more bins than the spacing has pixels: with bins finer than the
  // samples, empty ones fall between the full ones and every phase reads as a
  // band of its own.
  const binCount = Math.max(2, Math.min(ROW_PHASE_BINS, Math.floor(lineSpacing)));

  const bins = new Array(binCount).fill(0);
  let total = 0;
  for (let i = 0; i < profile.length; i++) {
    const phase = i % lineSpacing;
    bins[Math.min(binCount - 1, Math.floor((phase / lineSpacing) * binCount))] += profile[i];
    total += profile[i];
  }
  if (total === 0) return 1;

  // Counted well below the peak, because a row is not one smooth hump: ink
  // thins out between the tops of the capitals and the x-height band, and a
  // threshold near the average splits a single row in two there. The gap
  // between one row and the next has next to no ink in it at all, which is what
  // separates rows from the dips inside them.
  //
  // Counted around the cycle from the emptiest phase, so a band straddling the
  // wrap-around isn't counted twice.
  const threshold = Math.max(...bins) * BAND_THRESHOLD;
  const start = bins.indexOf(Math.min(...bins));
  let bands = 0;
  let inBand = false;
  for (let i = 0; i < binCount; i++) {
    const above = bins[(start + i) % binCount] > threshold;
    if (above && !inBand) bands++;
    inBand = above;
  }

  return Math.min(MAX_ROWS_PER_LINE, Math.max(1, bands));
}

interface RowGrid {
  pitch: number;
  centers: number[];
  baselines: number[];
}

/**
 * Where each row's baseline sits, from the line numbers' feet.
 *
 * Digits have no descenders, so the bottom of a line number's ink is the text
 * baseline itself - a fixed landmark in the line box, unlike the ink of text,
 * which starts and ends wherever that line's characters happen to reach.
 */
function fitBaselines(gutter: GutterAnalysis, firstCenter: number, pitch: number, centers: number[]): number[] {
  const offsets: number[] = [];
  for (const run of gutter.digitRuns) {
    const k = Math.round(((run.start + run.end) / 2 - firstCenter) / pitch);
    offsets.push(run.end - (firstCenter + pitch * k));
  }

  // Without any line numbers to go on, the middle of the box is the best guess.
  const offset = offsets.length > 0 ? median(offsets) : 0;
  return centers.map((c) => c + offset);
}

function fallbackGrid(gutter: GutterAnalysis): RowGrid {
  return {
    pitch: gutter.cellHeightPx,
    centers: gutter.rowYCenters,
    baselines: gutter.rowYCenters,
  };
}

/**
 * Trims rows off the ends of the grid that have nothing on them.
 *
 * Past the end of the document the editor draws neither text nor a line number,
 * but a photograph still has sensor noise and a darkening corner, and a few
 * stray pixels per row are enough to stretch the grid beyond where the document
 * stops. Only the ends are trimmed, and the bar is low: a blank line inside a
 * document still has its number, which is a small fraction of what a line of
 * text inks but far more than noise.
 */
function withInk(centers: number[], profile: number[], y0: number, pitch: number): number[] {
  if (centers.length === 0) return centers;

  const inkOf = (center: number): number => {
    let sum = 0;
    const from = Math.max(0, Math.round(center - pitch / 2 - y0));
    const to = Math.min(profile.length, Math.round(center + pitch / 2 - y0));
    for (let i = from; i < to; i++) sum += profile[i];
    return sum;
  };

  const inks = centers.map(inkOf);
  const typical = median(inks.filter((v) => v > 0));
  if (!Number.isFinite(typical) || typical <= 0) return centers;

  const floor = typical * MIN_ROW_INK_SHARE;
  let first = 0;
  let last = centers.length - 1;
  while (first <= last && inks[first] < floor) first++;
  while (last >= first && inks[last] < floor) last--;
  return centers.slice(first, last + 1);
}

/** The value at `fraction` of the way up a set of samples. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** Median gap between the centers of consecutive bands. */
function spacingOf(bands: Array<{ start: number; end: number }>): number {
  const diffs: number[] = [];
  for (let i = 1; i < bands.length; i++) {
    diffs.push((bands[i].start + bands[i].end) / 2 - (bands[i - 1].start + bands[i - 1].end) / 2);
  }
  return median(diffs);
}

function filterShortBands(
  bands: Array<{ start: number; end: number }>,
  spacing: number
): Array<{ start: number; end: number }> {
  if (!Number.isFinite(spacing) || spacing <= 0) return bands;
  const kept = bands.filter((b) => b.end - b.start >= spacing * MIN_DIGIT_HEIGHT);
  return kept.length >= 2 ? kept : bands;
}

/** Inked pixel count for each row of the body, line numbers and text alike. */
function rowInkProfile(image: ImageData, margins: MarginBounds): number[] {
  const x0 = Math.max(0, Math.round(margins.gutterLeftX));
  const x1 = Math.min(image.width, Math.round(margins.textAreaRightX));
  const y0 = Math.max(0, Math.round(margins.bodyTopY));
  const y1 = Math.min(image.height, Math.round(margins.bodyBottomY));
  if (x1 - x0 < 2 || y1 - y0 < 2) return [];

  // Thresholded against each row's own page brightness rather than one level
  // for the whole body. Light falls unevenly across a photographed screen, and
  // a single threshold that fits the top of the window calls the bottom corner
  // ink - which conjures rows out of blank page past the end of the document.
  const limit = (x1 - x0) * MAX_ROW_INK_FRACTION;
  const counts = new Array(y1 - y0).fill(0);

  const row = new Array(x1 - x0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      row[x - x0] = luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }

    const page = percentile(row, PAGE_PERCENTILE);
    const threshold = page * INK_FRACTION_OF_PAGE;
    let count = 0;
    for (const value of row) if (value <= threshold) count++;
    counts[y - y0] = count > limit ? 0 : count;
  }
  return counts;
}

/**
 * Measures the character grid from the text itself: how wide a cell is, and
 * where the boundary between one cell and the next falls.
 *
 * The gutter can only offer the width of a digit's ink, which is narrower than
 * the cell that holds it by both side bearings - a systematic underestimate that
 * drifts a whole cell every eight or so columns. The text area has hundreds of
 * characters laid out on the real grid, and the spacing that grid repeats at is
 * the advance width, whatever the ink inside each cell happens to look like.
 */
function fitColumns(image: ImageData, margins: MarginBounds, cellHeightPx: number): GridFit | null {
  if (!Number.isFinite(cellHeightPx) || cellHeightPx <= 0) return null;

  const x0 = Math.max(0, Math.round(margins.textAreaLeftX));
  const x1 = Math.min(image.width, Math.round(margins.textAreaRightX));
  const y0 = Math.max(0, Math.round(margins.bodyTopY));
  const y1 = Math.min(image.height, Math.round(margins.bodyBottomY));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;

  const profile = columnInkProfile(image, x0, x1, y0, y1);
  if (profile.filter((v) => v > 0).length < MIN_INK_COLUMNS) return null;

  const minWidth = cellHeightPx * MIN_ADVANCE_RATIO;
  const maxWidth = cellHeightPx * MAX_ADVANCE_RATIO;

  let coarse = null;
  let coarseScore = -Infinity;
  for (let width = minWidth; width <= maxWidth; width += WIDTH_COARSE_STEP) {
    const score = periodicityScore(profile, width);
    if (score > coarseScore) {
      coarseScore = score;
      coarse = width;
    }
  }
  if (coarse === null) return null;

  // Sharpen it, now also on the gaps between characters. Which spacing the text
  // repeats at is a coarse question and the spread of the ink answers it; how
  // precisely it repeats is a fine one, and a fraction of a percent per column
  // is half a glyph by the end of a long line. The gaps are where a small error
  // shows first - they fill in as soon as the grid starts sliding off the
  // characters - while the spread keeps the answer anchored to the right
  // spacing rather than a slightly better-looking neighbour.
  //
  // The phase that empties the gaps is the grid's own origin, so it comes back
  // with the width rather than being assumed from the margin.
  let best: GridFit | null = null;
  let bestScore = -Infinity;
  for (let width = coarse * (1 - WIDTH_POLISH); width <= coarse * (1 + WIDTH_POLISH); width += WIDTH_FINE_STEP) {
    const gap = emptiestPhase(profile, width);
    const score = gap.depth * periodicityScore(profile, width);
    if (score > bestScore) {
      bestScore = score;
      best = { width, originX: x0 + gap.phase };
    }
  }
  return best;
}

interface GridFit {
  width: number;
  originX: number;
}

/**
 * The phase within a cell where the text has least ink, and how empty it is.
 *
 * At the right width and phase every cell boundary lands in the gap between two
 * characters, and that phase comes out close to empty. A width that is slightly
 * wrong slides the boundary onto the characters a little more with every
 * column, and the gap fills in - which makes this a much sharper measure of a
 * small error than the overall spread of the ink, and it names the boundary
 * outright.
 *
 * The phase is swept continuously rather than binned, because the boundary is
 * wanted to a fraction of a pixel: a bin wide enough to hold a useful number of
 * columns is a tenth of a cell, and a tenth of a cell is the difference between
 * a template landing on a glyph and landing between two.
 */
function emptiestPhase(profile: number[], width: number): { phase: number; depth: number } {
  let total = 0;
  for (const value of profile) total += value;
  if (total === 0) return { phase: 0, depth: 0 };
  const mean = total / profile.length;

  // Each boundary is read as a narrow band rather than a single line of pixels:
  // one line is a sample of one, and noise in it moves the answer.
  const half = (width * BOUNDARY_BAND) / 2;

  let bestPhase = 0;
  let leastInk = Infinity;
  for (let phase = 0; phase < width; phase += PHASE_STEP) {
    let ink = 0;
    let samples = 0;
    for (let x = phase; x < profile.length; x += width) {
      for (let dx = -half; dx <= half; dx += PHASE_STEP) {
        ink += sampleAt(profile, x + dx);
        samples++;
      }
    }
    if (samples === 0) continue;
    const perBoundary = ink / samples;
    if (perBoundary < leastInk) {
      leastInk = perBoundary;
      bestPhase = phase;
    }
  }

  return { phase: bestPhase, depth: Math.max(0, (mean - leastInk) / mean) };
}

/** The profile at a fractional position, between its two neighbouring columns. */
function sampleAt(profile: number[], x: number): number {
  const i = Math.floor(x);
  if (i < 0 || i >= profile.length) return 0;
  if (i + 1 >= profile.length) return profile[i];
  const f = x - i;
  return profile[i] * (1 - f) + profile[i + 1] * f;
}

/** Foreground pixel count per column, thresholded over the region as a whole. */
function columnInkProfile(image: ImageData, x0: number, x1: number, y0: number, y1: number): number[] {
  const values: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      values.push(luminance(image.data[i], image.data[i + 1], image.data[i + 2]));
    }
  }
  const threshold = otsuThreshold(values);

  const profile = new Array(x1 - x0).fill(0);
  let index = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (values[index++] <= threshold) profile[x - x0]++;
    }
  }
  return profile;
}

/**
 * How strongly a profile repeats at `width`: fold every column onto its phase
 * within one cell and measure how unevenly the ink lands.
 *
 * At the true advance width, ink piles into the phases where glyphs have strokes
 * and stays out of the ones where cells meet. At any other width the same ink
 * spreads evenly across phases, so the contrast collapses.
 */
function periodicityScore(profile: number[], width: number): number {
  const bins = new Array(PHASE_BINS).fill(0);
  let total = 0;

  for (let x = 0; x < profile.length; x++) {
    const phase = ((x % width) + width) % width;
    bins[Math.min(PHASE_BINS - 1, Math.floor((phase / width) * PHASE_BINS))] += profile[x];
    total += profile[x];
  }
  if (total === 0) return 0;

  const mean = total / PHASE_BINS;
  let variance = 0;
  for (const bin of bins) variance += (bin - mean) ** 2;
  return variance / (mean * mean);
}

interface GutterAnalysis {
  rowYCenters: number[];
  cellHeightPx: number;
  /** The vertical extent of each row's line-number ink; its end is that row's baseline. */
  digitRuns: Array<{ start: number; end: number }>;
  /** The old estimate: digit ink extent divided by digit count. Biased narrow; a last resort. */
  widthFromDigits: (seedWidth: number) => number;
}

/** Row bands and their digit blobs, from the line number margin. */
function analyzeGutter(image: ImageData, margins: MarginBounds): GutterAnalysis {
  const { gutterLeftX, gutterRightEdgeX, bodyTopY, bodyBottomY } = margins;
  const cropWidth = gutterRightEdgeX - gutterLeftX;
  const cropHeight = bodyBottomY - bodyTopY;

  const gray = new Float32Array(Math.max(0, cropWidth * cropHeight));
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const i = ((bodyTopY + y) * image.width + (gutterLeftX + x)) * 4;
      gray[y * cropWidth + x] = luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
  }

  const threshold = otsuThreshold(Array.from(gray));

  // Otsu convention: values <= threshold are one class, values > threshold the other.
  let belowCount = 0;
  for (const v of gray) if (v <= threshold) belowCount++;
  const foregroundIsBelow = belowCount <= gray.length - belowCount;

  const isForeground = (v: number) => (foregroundIsBelow ? v <= threshold : v > threshold);

  const rowProjection = new Array(cropHeight).fill(0);
  for (let y = 0; y < cropHeight; y++) {
    let count = 0;
    for (let x = 0; x < cropWidth; x++) {
      if (isForeground(gray[y * cropWidth + x])) count++;
    }
    rowProjection[y] = count;
  }

  // Both ends of the count mean "not a line number". A lone dark pixel is the
  // window's own border edge, and at one pixel per row it bridges the gaps
  // between digits and splits each one into pieces. A row that is dark right
  // across the margin is the soft edge where the body meets the chrome, and it
  // merges into the first or last digit and drags its center half a row off.
  const gutterInkLimit = cropWidth * MAX_ROW_INK_FRACTION;
  const bands = findRuns(rowProjection.map((c) => c >= MIN_ROW_INK && c <= gutterInkLimit));

  // Two passes: the bands give a rough line spacing, and that spacing says which
  // of them were too small to have been a number in the first place.
  const rowRuns = filterShortBands(bands, spacingOf(bands));
  const rowYCenters = rowRuns.map((r) => bodyTopY + (r.start + r.end) / 2);
  const cellHeightPx = spacingOf(rowRuns);

  const widthFromDigits = (seedWidth: number): number => {
    const refinedWidths: number[] = [];
    for (const run of rowRuns) {
      let minX = -1;
      let maxX = -1;
      for (let x = 0; x < cropWidth; x++) {
        let hasForeground = false;
        for (let y = run.start; y < run.end; y++) {
          if (isForeground(gray[y * cropWidth + x])) {
            hasForeground = true;
            break;
          }
        }
        if (hasForeground) {
          if (minX === -1) minX = x;
          maxX = x;
        }
      }
      if (minX === -1) continue;

      const blobWidth = maxX - minX + 1;
      if (blobWidth < seedWidth * MIN_BLOB_WIDTH_FRACTION) continue;

      const digitCount = Math.max(1, Math.round(blobWidth / seedWidth));
      refinedWidths.push(blobWidth / digitCount);
    }
    return refinedWidths.length > 0 ? median(refinedWidths) : seedWidth;
  };

  const digitRuns = rowRuns.map((r) => ({ start: bodyTopY + r.start, end: bodyTopY + r.end }));

  return { rowYCenters, cellHeightPx, digitRuns, widthFromDigits };
}
