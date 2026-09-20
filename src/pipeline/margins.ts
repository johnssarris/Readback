import { colLuminance, findRuns, rowLuminance } from "./imageUtils";

export interface MarginBounds {
  bodyTopY: number;
  bodyBottomY: number;
  gutterLeftX: number;
  gutterRightEdgeX: number;
  textAreaLeftX: number;
  textAreaRightX: number;
}

/** Minimum row-to-row / column-to-column luminance jump to count as a region boundary. */
export const BOUNDARY_THRESHOLD = 12;

/** Boundaries closer together than this (px) are treated as the same edge (anti-aliasing). */
const MERGE_DISTANCE = 3;

/** Fraction of width/height skipped at each edge before looking for the first real boundary,
 *  to avoid tripping on the rectified window's own outer border. */
const EDGE_SKIP_FRACTION = 0.01;

/**
 * Locates the editor body (excluding tab bar / status bar / menu bar) via a horizontal
 * color-band scan, then locates the gutter/text-area boundary via a vertical scan within
 * the body. Assumes whole-window framing (see plan: Design decisions).
 */
export function detectMargins(image: ImageData): MarginBounds {
  const { width, height } = image;

  const rowLum = new Array(height);
  for (let y = 0; y < height; y++) rowLum[y] = rowLuminance(image, y);

  const rowBoundaries = findBoundaries(rowLum);
  const [bodyTopY, bodyBottomY] = tallestBand(rowBoundaries, height);

  const colLum = new Array(width);
  for (let x = 0; x < width; x++) colLum[x] = colLuminance(image, x, bodyTopY, bodyBottomY);

  const colBoundaries = findBoundaries(colLum);

  const skipLeft = Math.round(width * EDGE_SKIP_FRACTION);
  const skipRight = width - Math.round(width * EDGE_SKIP_FRACTION);

  const gutterRightEdgeX = colBoundaries.find((b) => b > skipLeft) ?? Math.round(width * 0.08);
  const textAreaRightCandidate = [...colBoundaries].reverse().find((b) => b < skipRight && b > gutterRightEdgeX);
  const textAreaRightX = textAreaRightCandidate ?? width;

  return {
    bodyTopY,
    bodyBottomY,
    gutterLeftX: 0,
    gutterRightEdgeX,
    textAreaLeftX: gutterRightEdgeX,
    textAreaRightX,
  };
}

/** Finds boundary indices where the 1D luminance profile jumps by more than the threshold. */
function findBoundaries(profile: number[]): number[] {
  const diffs: number[] = [0];
  for (let i = 1; i < profile.length; i++) {
    diffs.push(Math.abs(profile[i] - profile[i - 1]));
  }

  const isPeak = diffs.map((d) => d > BOUNDARY_THRESHOLD);
  const runs = findRuns(isPeak);

  // Collapse each run of adjacent above-threshold diffs into a single boundary at its midpoint,
  // then merge boundaries that ended up within MERGE_DISTANCE of each other.
  const raw = runs.map((r) => Math.round((r.start + r.end) / 2));
  const merged: number[] = [];
  for (const b of raw) {
    if (merged.length > 0 && b - merged[merged.length - 1] <= MERGE_DISTANCE) {
      continue;
    }
    merged.push(b);
  }
  return merged;
}

/** Given sorted boundary indices over a profile of length `total`, returns the [start, end) of the tallest band. */
function tallestBand(boundaries: number[], total: number): [number, number] {
  const edges = [0, ...boundaries, total];
  let best: [number, number] = [0, total];
  let bestSize = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const size = edges[i + 1] - edges[i];
    if (size > bestSize) {
      bestSize = size;
      best = [edges[i], edges[i + 1]];
    }
  }
  return best;
}
