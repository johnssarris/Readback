import type { CellPitch } from "../pipeline/calibrate";
import type { MarginBounds } from "../pipeline/margins";
import { matchCell, type GlyphAtlas } from "../pipeline/match";
import { readLineNumbers } from "../pipeline/lineNumbers";
import type { Rect } from "../pipeline/imageUtils";

export interface CellResult {
  char: string;
  confidence: number;
  candidates: { char: string; score: number }[];
  flagged: boolean;
  corrected: boolean;
  rect: Rect;
}

export interface LineRow {
  /** Real line number read from the gutter, not assumed sequential. NaN if unreadable. */
  lineNumber: number;
  lineNumberConfidence: number;
  cells: CellResult[];
  yRangePx: { top: number; bottom: number };
  /** True when the gutter showed no number for this row (Notepad++ leaves wrapped display rows blank). */
  isWrappedContinuation: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Capture {
  captureId: string;
  timestamp: number;
  rows: LineRow[];
  cellPitch: { widthPx: number; heightPx: number };
  margins: MarginBounds;
  sourceCorners: [Point, Point, Point, Point];
  calibration: {
    fontSizePt: number | null;
    displayScalingPct: number | null;
    notepadVersionHint: string;
  };
}

/** Fallback share of the line box above the baseline, when the atlas doesn't say. */
const DEFAULT_BASELINE_FRACTION = 0.8;

/**
 * A cell's sampling box, kept inside the editor body.
 *
 * The first and last rows of a screenful sit hard against the window chrome,
 * and a box that overhangs by even a pixel pulls in a band of it - which reads
 * as ink, so a blank cell stops being blank and a line number grows a digit it
 * never had.
 */
function cellRect(x: number, rowTop: number, pitch: CellPitch, margins: MarginBounds): Rect {
  const top = Math.max(rowTop, margins.bodyTopY);
  const bottom = Math.min(rowTop + pitch.heightPx, margins.bodyBottomY);
  return { x, y: top, w: pitch.widthPx, h: Math.max(1, bottom - top) };
}

function cellResultFromMatch(rect: Rect, match: ReturnType<typeof matchCell>): CellResult {
  return {
    char: match.char,
    confidence: match.confidence,
    candidates: match.candidates,
    flagged: match.flagged,
    corrected: false,
    rect,
  };
}

/**
 * Assembles the full recognized `LineRow[]` for a captured, rectified screenful: reads each
 * row's real line number from the gutter, segments the text area into character cells at the
 * self-calibrated pitch, and matches every cell against the glyph atlas (Stages 4-6).
 *
 * A row's box is hung from its baseline rather than centered on its ink, because
 * that is how the templates are drawn: a glyph sits on the baseline with the
 * ascent above it. Centering a row on whatever ink it happens to carry would
 * shift every cell in it against the templates by a different amount.
 */
export function buildRows(image: ImageData, margins: MarginBounds, pitch: CellPitch, atlas: GlyphAtlas): LineRow[] {
  const { textAreaRightX } = margins;
  const originX = pitch.columnOriginX;
  const columnCount = Math.floor((textAreaRightX - originX) / pitch.widthPx);
  const ascent = (atlas.baselineFraction ?? DEFAULT_BASELINE_FRACTION) * pitch.heightPx;

  const rowTops = pitch.rowYCenters.map((yCenter, index) => {
    const baseline = pitch.rowBaselines?.[index];
    return baseline !== undefined ? baseline - ascent : yCenter - pitch.heightPx / 2;
  });
  const numbers = readLineNumbers(
    image,
    margins,
    atlas,
    rowTops.map((top) => ({ top, bottom: top + pitch.heightPx }))
  );

  return rowTops.map((rowTop, index) => {
    const rowBottom = rowTop + pitch.heightPx;
    const number = numbers[index];

    const cells: CellResult[] = [];
    for (let col = 0; col < columnCount; col++) {
      const rect = cellRect(originX + col * pitch.widthPx, rowTop, pitch, margins);
      cells.push(cellResultFromMatch(rect, matchCell(image, rect, atlas)));
    }

    return {
      lineNumber: number.value,
      lineNumberConfidence: number.confidence,
      cells,
      yRangePx: { top: rowTop, bottom: rowBottom },
      isWrappedContinuation: !number.hasNumber,
    };
  });
}

/**
 * Reconstructs plain text from corrected rows, trimming trailing background padding per row.
 *
 * A wrapped continuation is a display row, not a line: the editor broke one long
 * line across several rows, so the text goes back onto the end of the row above
 * rather than starting a new line of its own.
 *
 * Whether a space goes back in with it is not visible on screen - the space a
 * line was broken at is rendered as blank, exactly like the padding beyond the
 * end of a row. What is visible is whether the row above ran out of columns: a
 * row broken at a word leaves some, a row broken mid-word fills every one.
 */
export function rowsToText(rows: LineRow[]): string {
  const lines: string[] = [];
  let previousFilledItsRow = false;

  for (const row of rows) {
    let lastNonBlank = -1;
    row.cells.forEach((cell, i) => {
      if (cell.char !== "" && cell.char !== " ") lastNonBlank = i;
    });
    const text = row.cells
      .slice(0, lastNonBlank + 1)
      .map((c) => (c.char === "" ? " " : c.char))
      .join("");

    if (row.isWrappedContinuation && lines.length > 0) {
      lines[lines.length - 1] += (previousFilledItsRow ? "" : " ") + text;
    } else {
      lines.push(text);
    }
    previousFilledItsRow = lastNonBlank === row.cells.length - 1;
  }

  return lines.join("\n");
}

export function createCapture(
  rows: LineRow[],
  cellPitch: { widthPx: number; heightPx: number },
  margins: MarginBounds,
  sourceCorners: [Point, Point, Point, Point],
  calibration: Capture["calibration"]
): Capture {
  return {
    captureId: crypto.randomUUID(),
    timestamp: Date.now(),
    rows,
    cellPitch,
    margins,
    sourceCorners,
    calibration,
  };
}
