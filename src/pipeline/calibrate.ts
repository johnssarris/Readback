import { findRuns, luminance, median, otsuThreshold } from "./imageUtils";
import type { MarginBounds } from "./margins";

export interface CellPitch {
  widthPx: number;
  heightPx: number;
  /** Vertical center (in full rectified-image coordinates) of each detected gutter row. */
  rowYCenters: number[];
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
const WIDTH_STEP = 0.02;

/** Phase bins used to score a candidate width. */
const PHASE_BINS = 12;

/** Columns of text ink needed before the text area is worth measuring. */
const MIN_INK_COLUMNS = 12;

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
  const heightPx = gutter.cellHeightPx;

  const widthPx =
    estimateWidthFromText(image, margins, heightPx) ?? gutter.widthFromDigits(heightPx * ASSUMED_ASPECT_RATIO);

  return { widthPx, heightPx, rowYCenters: gutter.rowYCenters };
}

/**
 * Measures the advance width from the text itself, by finding the column
 * spacing the text area is actually periodic at.
 *
 * The gutter can only offer the width of a digit's ink, which is narrower than
 * the cell that holds it by both side bearings - a systematic underestimate that
 * drifts a whole cell every eight or so columns. The text area has hundreds of
 * characters laid out on the real grid, and the spacing that grid repeats at is
 * the advance width, whatever the ink inside each cell happens to look like.
 */
function estimateWidthFromText(image: ImageData, margins: MarginBounds, cellHeightPx: number): number | null {
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

  let bestWidth = null;
  let bestScore = -Infinity;
  for (let width = minWidth; width <= maxWidth; width += WIDTH_STEP) {
    const score = periodicityScore(profile, width);
    if (score > bestScore) {
      bestScore = score;
      bestWidth = width;
    }
  }
  return bestWidth;
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

  const rowRuns = findRuns(rowProjection.map((c) => c > 0));
  const rowYCenters = rowRuns.map((r) => bodyTopY + (r.start + r.end) / 2);

  const heightDiffs: number[] = [];
  for (let i = 1; i < rowYCenters.length; i++) {
    heightDiffs.push(rowYCenters[i] - rowYCenters[i - 1]);
  }
  const cellHeightPx = median(heightDiffs);

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

  return { rowYCenters, cellHeightPx, widthFromDigits };
}
