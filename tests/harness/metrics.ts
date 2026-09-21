import { luminance } from "../../src/pipeline/imageUtils";
import type { MarginBounds } from "../../src/pipeline/margins";
import type { CellPitch } from "../../src/pipeline/calibrate";

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
      for (let x = Math.round(margins.textAreaLeftX); x < Math.round(margins.textAreaRightX); x += 3) {
        const i = (y * image.width + x) * 4;
        samples.push(luminance(image.data[i], image.data[i + 1], image.data[i + 2]));
      }
    }
    samples.sort((a, b) => a - b);
    const page = samples.length > 0 ? samples[Math.floor(samples.length * 0.9)] : 255;
    const threshold = page * 0.55;

    const row: boolean[] = [];
    for (let col = 0; col < columns; col++) {
      const x0 = Math.round(margins.textAreaLeftX + col * pitch.widthPx);
      const x1 = Math.round(margins.textAreaLeftX + (col + 1) * pitch.widthPx);
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
