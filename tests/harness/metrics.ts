import { luminance } from "../../src/pipeline/imageUtils";
import type { MarginBounds } from "../../src/pipeline/margins";
import type { CellPitch } from "../../src/pipeline/calibrate";
import type { CaptureMeasures } from "./capture";

/**
 * Metrics for a pipeline run against a fixture.
 *
 * The geometry ones (margins, pitch, rows, ink) need no glyph atlas: they
 * measure whether the grid landed on the text, which is the part a rendered
 * fixture can speak to honestly. `cer` needs an atlas and is only as meaningful
 * as the fixture it ran on - on a Chromium render it compares one canvas
 * rendering against another and flatters a canvas-built atlas.
 */
export interface Metrics {
  bodyTopErrorPx: number | null;
  bodyBottomErrorPx: number | null;
  gutterEdgeErrorPx: number | null;
  cellWidthErrorPct: number | null;
  cellHeightErrorPct: number | null;
  rowsDetected: number;
  rowsExpected: number;
  /** Mean |detected row center - true row center|, in detected cell heights. */
  rowOffsetCells: number | null;
  /** Cells correctly called ink vs blank, against the ground-truth text. */
  inkAccuracy: number;
  /** Lines whose first inked column matches the truth's leading-space count. */
  indentAccuracy: number;
  /** Character error rate, when an atlas was available. */
  cer: number | null;
  /** Rows whose line number - or absence of one - was read correctly. */
  numberAccuracy: number | null;
  /** Mean distance from each detected pane corner to where the markers were drawn. */
  markerErrorPx: number | null;
  /** Spread of the column grid's best phase across the line, in cells; see columnWander. */
  columnWanderCells: number | null;
  /** The capture as a photograph, when its markers were found and its pane's size is known; see measureCapture. */
  capture: CaptureMeasures | null;
  /** Where the read went wrong, when there was a read; see errorBreakdown. */
  errors: ErrorBreakdown | null;
}

/**
 * Fraction of rows whose line number came back right, counting a row that
 * should have had no number and got one (or the reverse) as wrong.
 *
 * Nothing else measures this: a misread number costs nothing in CER unless it
 * is missed entirely, in which case the row is taken for a wrapped continuation
 * and its line is glued onto the one above.
 */
export function numberAccuracy(
  rows: Array<{ lineNumber: number; isWrappedContinuation: boolean }>,
  expected: (number | null)[]
): number {
  let correct = 0;
  for (let i = 0; i < expected.length; i++) {
    const row = rows[i];
    const want = expected[i];
    if (!row) continue;
    if (want === null) {
      if (row.isWrappedContinuation) correct++;
    } else if (!row.isWrappedContinuation && row.lineNumber === want) {
      correct++;
    }
  }
  return expected.length === 0 ? 0 : correct / expected.length;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Character error rate against the ground truth, per line so a dropped row costs its own length. */
export function characterErrorRate(recognized: string, truth: string): number {
  const rec = recognized.split("\n").map((l) => l.replace(/\s+$/, ""));
  const exp = truth.split("\n").map((l) => l.replace(/\s+$/, ""));
  let distance = 0;
  let length = 0;
  for (let i = 0; i < Math.max(rec.length, exp.length); i++) {
    distance += levenshtein(rec[i] ?? "", exp[i] ?? "");
    length += (exp[i] ?? "").length;
  }
  return length === 0 ? 0 : distance / length;
}

/**
 * Per-cell ink test, atlas-free: a cell counts as inked when its darkest pixel
 * sits well below the local page brightness. Under uneven lighting a fixed
 * threshold drifts, so the reference is the row's own bright end.
 */
export function inkMap(
  image: ImageData,
  margins: MarginBounds,
  pitch: CellPitch,
  columns: number
): boolean[][] {
  const map: boolean[][] = [];

  for (const yCenter of pitch.rowYCenters) {
    const top = Math.round(yCenter - pitch.heightPx / 2);
    const bottom = Math.min(image.height, Math.round(yCenter + pitch.heightPx / 2));

    // Page brightness for this row: the 90th percentile over the text area,
    // which is background wherever the row is not solid ink.
    const samples: number[] = [];
    for (let y = top; y < bottom; y++) {
      if (y < 0) continue;
      for (let x = Math.round(pitch.columnOriginX); x < Math.round(margins.textAreaRightX); x += 3) {
        const i = (y * image.width + x) * 4;
        samples.push(luminance(image.data[i], image.data[i + 1], image.data[i + 2]));
      }
    }
    samples.sort((a, b) => a - b);
    const page = samples.length > 0 ? samples[Math.floor(samples.length * 0.9)] : 255;
    const threshold = page * 0.55;

    const row: boolean[] = [];
    for (let col = 0; col < columns; col++) {
      const x0 = Math.round(pitch.columnOriginX + col * pitch.widthPx);
      const x1 = Math.round(pitch.columnOriginX + (col + 1) * pitch.widthPx);
      let darkest = 255;
      for (let y = top; y < bottom; y++) {
        if (y < 0) continue;
        for (let x = x0; x < x1 && x < image.width; x++) {
          if (x < 0) continue;
          const i = (y * image.width + x) * 4;
          const l = luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
          if (l < darkest) darkest = l;
        }
      }
      row.push(darkest < threshold);
    }
    map.push(row);
  }
  return map;
}

/** Stretches of the text area the column grid is checked in, left to right. */
const WANDER_SPANS = 6;

/**
 * How far the column grid wanders from the text across the line, in cells.
 *
 * The grid is one width and one origin for the whole pane. In each sixth of the
 * text area, the phase that puts the cell boundaries in the gaps between
 * characters is found on its own, and what is returned is how far apart those
 * phases are. A grid that fits the whole line scores zero; one that is simply
 * offset scores zero too, and shows in indent instead.
 *
 * Two things score above zero, and this does not tell them apart: a rectified
 * image that is not evenly scaled from side to side, which is what a bowed
 * capture gives, and a cell width a little off, which slides the grid steadily
 * across the line. The simulated camera is a pure perspective view, so what it
 * scores is the second.
 */
export function columnWander(image: ImageData, margins: MarginBounds, pitch: CellPitch): number | null {
  const width = pitch.widthPx;
  if (!(width > 0)) return null;
  const x0 = Math.max(0, Math.round(pitch.columnOriginX));
  const x1 = Math.min(image.width, Math.round(margins.textAreaRightX));
  const y0 = Math.max(0, Math.round(margins.bodyTopY));
  const y1 = Math.min(image.height, Math.round(margins.bodyBottomY));
  if (x1 - x0 < width * WANDER_SPANS * 4 || y1 <= y0) return null;

  // Darkness summed down each column: continuous rather than thresholded, so
  // it does not depend on where a threshold happens to fall in a photograph.
  const profile = new Float64Array(x1 - x0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      profile[x - x0] += 255 - luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
  }
  const sample = (x: number) => {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= profile.length) return profile[Math.max(0, Math.min(profile.length - 1, i))];
    const f = x - i;
    return profile[i] * (1 - f) + profile[i + 1] * f;
  };

  const offset = pitch.columnOriginX - x0;
  const spans: Array<{ shift: number; ink: number }> = [];
  for (let span = 0; span < WANDER_SPANS; span++) {
    const from = ((x1 - x0) * span) / WANDER_SPANS;
    const to = ((x1 - x0) * (span + 1)) / WANDER_SPANS;
    let total = 0;
    for (let x = Math.floor(from); x < to; x++) total += profile[x];

    let best = 0;
    let least = Infinity;
    for (let shift = 0; shift < 1; shift += 0.02) {
      let ink = 0;
      let count = 0;
      const first = Math.ceil((from - offset) / width - shift);
      for (let k = first; offset + (k + shift) * width < to; k++) {
        ink += sample(offset + (k + shift) * width);
        count++;
      }
      if (count > 0 && ink / count < least) {
        least = ink / count;
        best = shift;
      }
    }
    spans.push({ shift: best, ink: total });
  }

  // A stretch with little text in it - the short ends of lines - has no gaps
  // worth the name, and its best phase is wherever the noise put it.
  const most = Math.max(...spans.map((s) => s.ink));
  const shifts = spans
    .filter((s) => s.ink >= most * WANDER_MIN_INK)
    .map((s) => s.shift)
    .sort((a, b) => a - b);
  if (shifts.length < 2) return null;

  // Phase is circular: a boundary a hair either side of a cell edge is the
  // same boundary. The spread is the shortest arc holding every phase, which is
  // a whole cell less the widest gap between neighbours round the circle.
  let widest = shifts[0] + 1 - shifts[shifts.length - 1];
  for (let i = 1; i < shifts.length; i++) widest = Math.max(widest, shifts[i] - shifts[i - 1]);
  return 1 - widest;
}

/** A stretch needs this share of the inkiest one's ink for its phase to count. */
const WANDER_MIN_INK = 0.3;

/** Fraction of cells whose ink/blank call matches the ground-truth text. */
export function inkAccuracy(map: boolean[][], lines: string[]): number {
  let correct = 0;
  let total = 0;
  const rows = Math.min(map.length, lines.length);
  for (let r = 0; r < rows; r++) {
    const line = lines[r];
    for (let c = 0; c < map[r].length; c++) {
      const expected = c < line.length && line[c] !== " ";
      if (map[r][c] === expected) correct++;
      total++;
    }
  }
  // Rows the pipeline never produced count as entirely wrong, so a dropped
  // row can't improve the score by disappearing.
  for (let r = rows; r < lines.length; r++) {
    total += lines[r].length;
  }
  return total === 0 ? 0 : correct / total;
}

/** Fraction of non-blank lines whose first inked column matches the truth's indent. */
export function indentAccuracy(map: boolean[][], lines: string[]): number {
  let correct = 0;
  let total = 0;
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    if (line.trim().length === 0) continue;
    total++;
    const row = map[r];
    if (!row) continue;
    const detected = row.indexOf(true);
    if (detected === line.length - line.trimStart().length) correct++;
  }
  return total === 0 ? 0 : correct / total;
}

/** Wrong cells out of all, as a pair, for a share of the pane or a kind of character. */
export type Tally = [wrong: number, total: number];

/**
 * Where on the pane, and on what, a read went wrong.
 *
 * Every cell of every row is compared with the character the truth has in
 * that column - the grid is fixed, so no alignment is needed - and the wrong
 * ones counted three ways. Across and down the pane, over the cells that should
 * hold a character: errors that grow toward the right or the bottom are the
 * grid drifting off the text, which is geometry. By what the character is:
 * errors that stay level across the pane but pile up on one kind of character
 * are the matching, which is recognition. And the two ways a cell can be wrong
 * about whether it holds anything at all.
 */
export interface ErrorBreakdown {
  /** Left, middle and right thirds of the text area; cells that should hold a character. */
  across: [Tally, Tally, Tally];
  /** Top, middle and bottom thirds of the rows; the same cells. */
  down: [Tally, Tally, Tally];
  byClass: { letter: Tally; digit: Tally; punct: Tally; blank: Tally };
  /** Cells that should hold a character and were read as blank. */
  inkToBlank: Tally;
  /** Cells that should be blank and were read as a character. */
  blankToInk: Tally;
}

export function errorBreakdown(rows: Array<{ cells: Array<{ char: string }> }>, truth: string[]): ErrorBreakdown {
  const tally = (): Tally => [0, 0];
  const out: ErrorBreakdown = {
    across: [tally(), tally(), tally()],
    down: [tally(), tally(), tally()],
    byClass: { letter: tally(), digit: tally(), punct: tally(), blank: tally() },
    inkToBlank: tally(),
    blankToInk: tally(),
  };
  const count = (t: Tally, wrong: boolean) => {
    t[1]++;
    if (wrong) t[0]++;
  };

  const n = Math.min(rows.length, truth.length);
  for (let r = 0; r < n; r++) {
    const cells = rows[r].cells;
    for (let c = 0; c < cells.length; c++) {
      const want = truth[r][c] ?? " ";
      const got = cells[c].char === "" ? " " : cells[c].char;
      const wrong = got !== want;
      if (want === " ") {
        count(out.byClass.blank, wrong);
        count(out.blankToInk, got !== " ");
        continue;
      }
      count(out.across[Math.min(2, Math.floor((3 * c) / cells.length))], wrong);
      count(out.down[Math.min(2, Math.floor((3 * r) / n))], wrong);
      count(out.byClass[/[A-Za-z]/.test(want) ? "letter" : /\d/.test(want) ? "digit" : "punct"], wrong);
      count(out.inkToBlank, got === " ");
    }
  }
  return out;
}

/** Adds one breakdown's counts into another's. */
export function addBreakdown(into: ErrorBreakdown, from: ErrorBreakdown): void {
  const add = (a: Tally, b: Tally) => {
    a[0] += b[0];
    a[1] += b[1];
  };
  for (let i = 0; i < 3; i++) {
    add(into.across[i], from.across[i]);
    add(into.down[i], from.down[i]);
  }
  for (const k of ["letter", "digit", "punct", "blank"] as const) add(into.byClass[k], from.byClass[k]);
  add(into.inkToBlank, from.inkToBlank);
  add(into.blankToInk, from.blankToInk);
}
