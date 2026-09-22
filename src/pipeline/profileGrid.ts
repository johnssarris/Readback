import { placeKnownRows, type CellPitch } from "./calibrate";
import { luminance } from "./imageUtils";
import type { MarginBounds } from "./margins";

/**
 * The character grid laid out from the screen's own numbers, rather than
 * searched for in the photograph.
 *
 * overlay.py asks the editor for them: how wide a cell is, how tall a row is,
 * and where the first column starts, in screen pixels from the pane's corner.
 * A capture framed by the corner markers is the pane and nothing else, so each
 * of those is a fixed multiple of its rectified pixels, and the grid follows
 * without estimating anything.
 *
 * What the numbers cannot know is how the photograph fell. A corner a
 * fraction of a pixel out moves every column with it, so the columns are
 * allowed a small shift - at most MAX_SHIFT of a cell - to the phase where the
 * gaps between characters are emptiest. And a photograph is not quite flat:
 * the pane's edges bow by a few pixels mid-way along, which squeezes the rows
 * and columns in the middle of the rectified image by up to a percent. Laid
 * out rigidly at the screen's own spacing, a grid drifts off the text by the
 * far end, and the real captures read worse that way than with the grid
 * estimated. So the profile settles what the photograph cannot - which of the
 * spacings that fit is the real one, how many rows there are, where the text
 * starts - and the photograph then sets the spacing to within AGREEMENT of it.
 *
 * A profile that no longer describes the screen - a font size or zoom changed
 * since it was printed - lines up best somewhere further off than that, and is
 * not believed at all (see ProfileCheck).
 */

/** The character grid, in screen pixels measured from the pane's top left corner. */
export interface GridProfile {
  /** Width of one character cell - fractional, since the editor lays text out in fractions of a pixel. */
  advance: number;
  /** Height of one row. */
  lineHeight: number;
  /** Where the first column of text starts: the line number margin's width, plus any gap after it. */
  textLeft: number;
}

export interface ProfileGrid {
  margins: MarginBounds;
  pitch: CellPitch;
  /** How far the columns were moved from where the profile put them, in cells. */
  shift: number;
  /** The spacing the photograph set, as a multiple of the profile's: across, and down. */
  stretch: { x: number; y: number };
  check: ProfileCheck;
}

/**
 * Whether the photograph agrees with the profile.
 *
 * `agrees` is false only when the text itself says otherwise: its columns
 * line up best at a width more than AGREEMENT from the profile's. A capture
 * too blurred for its columns to line up at any width says nothing either
 * way, and the profile stands, marked `evidence: false`.
 */
export interface ProfileCheck {
  agrees: boolean;
  evidence: boolean;
  /** The cell width the text lines up best at, as a multiple of the profile's. */
  bestRatio: number;
  /** How empty the gaps between characters are at the profile's width: 0 as inked as anywhere, 1 blank page. */
  fit: number;
  /** The same, at the best width. */
  bestFit: number;
}

/** Furthest the columns may move from where the profile puts them, in cells. */
const MAX_SHIFT = 0.3;

/** Step of the shift search, in cells. */
const SHIFT_STEP = 0.01;

/** Width of the band read at each cell boundary, as a share of the cell. */
const BOUNDARY_BAND = 0.12;

/**
 * The line number margin's own left edge, in screen pixels in from the pane's.
 * A rectified pane can carry a sliver of the window frame down its left side,
 * which read as part of the margin looks like a digit on every row.
 */
const GUTTER_INSET = 2;

/**
 * How far either side of the profile's cell width the text is asked where it
 * lines up best, and in what steps. Wide enough to take in a profile a font
 * size out of date - Cascadia Mono a point up or down is about 7% - and fine
 * enough not to step over the narrow peak a right width makes.
 */
const CHECK_SPAN = 0.1;
const CHECK_STEP = 0.004;

/**
 * How far from the profile's width the best width may be, as a share of it,
 * with the profile still taken to be right. A photograph can put it a percent
 * or so off - its scale is only as good as its corners, and the pane's edges
 * bow - where a stale profile is several percent out.
 */
const AGREEMENT = 0.03;

/**
 * Least fit at the best width for the text to count as evidence. Below it the
 * gaps are no emptier at any width than anywhere else, and where the best
 * width lands is noise.
 */
const MIN_EVIDENCE = 0.05;

export function gridFromProfile(image: ImageData, grid: GridProfile, pane: { width: number; height: number }): ProfileGrid {
  const sx = image.width / pane.width;
  const sy = image.height / pane.height;
  const width = grid.advance * sx;
  const height = grid.lineHeight * sy;
  const textLeft = grid.textLeft * sx;

  // Whole pixels, as detected margins are: what reads the line numbers crops
  // the margin at them. The columns keep their fraction in columnOriginX.
  const margins: MarginBounds = {
    bodyTopY: 0,
    bodyBottomY: image.height,
    gutterLeftX: Math.round(GUTTER_INSET * sx),
    gutterRightEdgeX: Math.round(textLeft),
    textAreaLeftX: Math.round(textLeft),
    textAreaRightX: image.width,
  };

  // Only rows the pane shows whole: the editor scrolls by whole lines, so the
  // first starts at the top, and whatever is left at the bottom is part of one.
  const whole = Math.floor(pane.height / grid.lineHeight + 1e-6);

  const columns = columnProfile(image, textLeft, width, whole * height);
  const check = checkWidth(columns, width, columns.fitAt(width).fit);
  const across = check.evidence && check.agrees ? check.bestRatio : 1;
  const cell = width * across;
  const at = columns.fitAt(cell);

  const down = rowStretch(image, textLeft, height, whole);
  const row = height * down;
  const centers = Array.from({ length: whole }, (_, k) => (k + 0.5) * row);
  const rows = placeKnownRows(image, margins, centers, row);

  return {
    margins,
    pitch: {
      widthPx: cell,
      heightPx: row,
      columnOriginX: textLeft + at.shift * cell,
      rowYCenters: rows.centers,
      rowBaselines: rows.baselines,
    },
    shift: at.shift,
    stretch: { x: across, y: down },
    check,
  };
}

function checkWidth(columns: ColumnProfile, width: number, fit: number): ProfileCheck {
  let bestRatio = 1;
  let bestFit = fit;
  for (let ratio = 1 - CHECK_SPAN; ratio <= 1 + CHECK_SPAN + 1e-9; ratio += CHECK_STEP) {
    const candidate = columns.fitAt(width * ratio).fit;
    if (candidate > bestFit) {
      bestFit = candidate;
      bestRatio = ratio;
    }
  }
  const evidence = bestFit >= MIN_EVIDENCE;
  return { agrees: !evidence || Math.abs(bestRatio - 1) <= AGREEMENT, evidence, bestRatio, fit, bestFit };
}

/**
 * The row spacing the photograph shows, as a multiple of the profile's, within
 * AGREEMENT of it.
 *
 * Read across the whole width of the text, where the rows are squeezed, rather
 * than from the line numbers at its left edge, where they are not. Without
 * enough text to say, or when the best spacing is at the edge of what is
 * allowed - which is the profile being wrong, not the photograph squeezing it -
 * the profile's own spacing stands.
 */
function rowStretch(image: ImageData, textLeft: number, height: number, rows: number): number {
  const x0 = Math.min(image.width, Math.ceil(textLeft));
  const y1 = Math.min(image.height, Math.round(rows * height));
  if (image.width - x0 < 4 || rows < 4) return 1;

  const profile = new Float64Array(y1);
  let total = 0;
  for (let y = 0; y < y1; y++) {
    for (let x = x0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      profile[y] += 255 - luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
    total += profile[y];
  }
  const mean = total / Math.max(1, y1);
  if (mean <= 0) return 1;

  // Each candidate spacing folds every row onto one, and the fold is scored by
  // how much contrast it keeps: at the true spacing each row's ink lands where
  // the last one's did, and a spacing off by a fraction of a percent smears it
  // a little more with every row. That uses the whole shape of every row, not
  // just the blank between them, which a small error barely moves.
  const fits: Array<{ ratio: number; fit: number }> = [];
  for (let ratio = 1 - AGREEMENT; ratio <= 1 + AGREEMENT + 1e-9; ratio += ROW_STEP) {
    fits.push({ ratio, fit: foldContrast(profile, height * ratio, mean) });
  }

  // Of fits too close to call, the one nearest the profile's own spacing: on
  // a render with no squeeze at all, the plain best was 0.1-0.2% off, which is
  // a tenth of a row by the bottom of a tall pane.
  const bestFit = Math.max(...fits.map((f) => f.fit));
  if (!(bestFit > 0)) return 1;
  const near = fits.filter((f) => f.fit >= bestFit * (1 - PLATEAU));
  const best = near.reduce((a, b) => (Math.abs(b.ratio - 1) < Math.abs(a.ratio - 1) ? b : a)).ratio;
  return Math.abs(best - 1) >= AGREEMENT - ROW_STEP ? 1 : best;
}

/**
 * How much of a profile's contrast survives folding it at `pitch`: the
 * variance of the folded profile over its mean squared. Each sample is split
 * between the two bins it falls between, so the fold is as fine as the pitch
 * is, not whole pixels.
 */
function foldContrast(profile: Float64Array, pitch: number, mean: number): number {
  const bins = Math.max(4, Math.round(pitch));
  const sums = new Float64Array(bins);
  for (let y = 0; y < profile.length; y++) {
    const at = ((y + 0.5) / pitch) * bins;
    const whole = Math.floor(at);
    const f = at - whole;
    sums[whole % bins] += profile[y] * (1 - f);
    sums[(whole + 1) % bins] += profile[y] * f;
  }
  const expected = (mean * profile.length) / bins;
  let variance = 0;
  for (const v of sums) variance += (v - expected) ** 2;
  return variance / bins / (expected * expected);
}

/** Fits within this share of the best count as equally good. */
const PLATEAU = 0.002;

/** Step of the row spacing search, in multiples of the profile's spacing. */
const ROW_STEP = 0.0005;

interface ColumnProfile {
  /** The shift, within MAX_SHIFT of a cell, that empties the boundaries most at this width, and how empty. */
  fitAt(width: number): { shift: number; fit: number };
}

/**
 * Darkness summed down each column of the text area, and the means to ask of
 * it where the boundaries between characters fall.
 *
 * Summed rather than thresholded, so the answer does not depend on where a
 * threshold happens to fall in a photograph. The boundaries are counted from
 * where the profile says text starts, which is right whatever the width: only
 * how far each one drifts from there depends on it.
 */
function columnProfile(image: ImageData, textLeft: number, width: number, bottom: number): ColumnProfile {
  const x0 = Math.max(0, Math.floor(textLeft - width));
  const x1 = image.width;
  const y1 = Math.min(image.height, Math.round(bottom));
  const none = { fitAt: () => ({ shift: 0, fit: 0 }) };
  if (x1 - x0 < width * 4 || y1 <= 0) return none;

  const profile = new Float64Array(x1 - x0);
  for (let y = 0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      profile[x - x0] += 255 - luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
  }

  // The mean over the text area alone: the line number margin has spacing of its own.
  let total = 0;
  let count = 0;
  for (let x = Math.ceil(textLeft) - x0; x < profile.length; x++) {
    total += profile[x];
    count++;
  }
  const mean = count > 0 ? total / count : 0;
  if (mean <= 0) return none;

  const sample = (x: number) => {
    const i = Math.floor(x - x0);
    if (i < 0 || i + 1 >= profile.length) return profile[Math.max(0, Math.min(profile.length - 1, i))];
    const f = x - x0 - i;
    return profile[i] * (1 - f) + profile[i + 1] * f;
  };

  return {
    fitAt(cell: number) {
      const half = (cell * BOUNDARY_BAND) / 2;
      const step = Math.max(0.1, half / 3);
      let best = 0;
      let least = Infinity;
      for (let shift = -MAX_SHIFT; shift <= MAX_SHIFT + 1e-9; shift += SHIFT_STEP) {
        let ink = 0;
        let samples = 0;
        for (let boundary = textLeft + shift * cell; boundary < x1; boundary += cell) {
          for (let dx = -half; dx <= half; dx += step) {
            ink += sample(boundary + dx);
            samples++;
          }
        }
        const perBoundary = samples > 0 ? ink / samples : Infinity;
        if (perBoundary < least) {
          least = perBoundary;
          best = shift;
        }
      }
      return { shift: best, fit: Math.max(0, (mean - least) / mean) };
    },
  };
}
