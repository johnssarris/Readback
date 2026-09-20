import type { CellPitch } from "../pipeline/calibrate";
import type { MarginBounds } from "../pipeline/margins";
import { matchCell, type GlyphAtlas } from "../pipeline/match";
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

/** Reads the right-aligned gutter digits for one row by matching cells backward from the gutter's right edge. */
function readLineNumber(
  image: ImageData,
  margins: MarginBounds,
  pitch: CellPitch,
  atlas: GlyphAtlas,
  rowTop: number
): { lineNumber: number; confidence: number; isWrappedContinuation: boolean } {
  const { gutterLeftX, gutterRightEdgeX } = margins;
  const maxSlots = Math.max(0, Math.floor((gutterRightEdgeX - gutterLeftX) / pitch.widthPx));

  const digits: string[] = [];
  const confidences: number[] = [];

  for (let k = 0; k < maxSlots; k++) {
    const x = gutterRightEdgeX - (k + 1) * pitch.widthPx;
    const rect: Rect = { x: Math.round(x), y: Math.round(rowTop), w: Math.round(pitch.widthPx), h: Math.round(pitch.heightPx) };
    const match = matchCell(image, rect, atlas);

    if (!/^[0-9]$/.test(match.char) || match.flagged) {
      break;
    }
    digits.unshift(match.char);
    confidences.unshift(match.confidence);
  }

  if (digits.length === 0) {
    return { lineNumber: NaN, confidence: 0, isWrappedContinuation: true };
  }

  const confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  return { lineNumber: parseInt(digits.join(""), 10), confidence, isWrappedContinuation: false };
}

/**
 * Assembles the full recognized `LineRow[]` for a captured, rectified screenful: reads each
 * row's real line number from the gutter, segments the text area into character cells at the
 * self-calibrated pitch, and matches every cell against the glyph atlas (Stages 4-6).
 */
export function buildRows(image: ImageData, margins: MarginBounds, pitch: CellPitch, atlas: GlyphAtlas): LineRow[] {
  const { textAreaLeftX, textAreaRightX } = margins;
  const columnCount = Math.floor((textAreaRightX - textAreaLeftX) / pitch.widthPx);

  return pitch.rowYCenters.map((yCenter) => {
    const rowTop = yCenter - pitch.heightPx / 2;
    const rowBottom = yCenter + pitch.heightPx / 2;

    const { lineNumber, confidence, isWrappedContinuation } = readLineNumber(image, margins, pitch, atlas, rowTop);

    const cells: CellResult[] = [];
    for (let col = 0; col < columnCount; col++) {
      const rect: Rect = {
        x: Math.round(textAreaLeftX + col * pitch.widthPx),
        y: Math.round(rowTop),
        w: Math.round(pitch.widthPx),
        h: Math.round(pitch.heightPx),
      };
      cells.push(cellResultFromMatch(rect, matchCell(image, rect, atlas)));
    }

    return {
      lineNumber,
      lineNumberConfidence: confidence,
      cells,
      yRangePx: { top: rowTop, bottom: rowBottom },
      isWrappedContinuation,
    };
  });
}

/** Reconstructs plain text from corrected rows, trimming trailing background padding per row. */
export function rowsToText(rows: LineRow[]): string {
  return rows
    .map((row) => {
      let lastNonBlank = -1;
      row.cells.forEach((cell, i) => {
        if (cell.char !== "" && cell.char !== " ") lastNonBlank = i;
      });
      return row.cells
        .slice(0, lastNonBlank + 1)
        .map((c) => (c.char === "" ? " " : c.char))
        .join("");
    })
    .join("\n");
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
