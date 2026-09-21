import type { CellPitch } from "../pipeline/calibrate";
import type { MarginBounds } from "../pipeline/margins";
import { CONFIDENCE_FLOOR, matchCell, type GlyphAtlas } from "../pipeline/match";
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

/** Rows sampled when locating the line numbers' right edge. */
const GUTTER_PROBE_ROWS = 6;

const DIGITS = "0123456789";

/**
 * The same atlas restricted to the characters a region can actually contain.
 *
 * The line number margin holds digits and nothing else, but matched against all
 * 95 glyphs a digit competes with its lookalikes - 0 against O, 1 against l, 5
 * against S - and the ambiguity rule then rejects a perfectly good reading as
 * too close to call. Against the ten characters that could really be there,
 * the question is only which digit.
 */
function restrictAtlas(atlas: GlyphAtlas, chars: string): GlyphAtlas {
  const glyphs = new Map<string, Float32Array>();
  for (const char of chars) {
    const glyph = atlas.glyphs.get(char);
    if (glyph) glyphs.set(char, glyph);
  }
  return { ...atlas, glyphs };
}

/**
 * A cell's sampling box, kept inside the editor body.
 *
 * The first and last rows of a screenful sit hard against the window chrome,
 * and a box that overhangs by even a pixel pulls in a band of it - which reads
 * as ink, so a blank cell stops being blank and a line number grows a digit it
 * never had.
 */
function cellRect(x: number, rowTop: number, pitch: CellPitch, margins: MarginBounds): Rect {
  const top = Math.max(Math.round(rowTop), Math.ceil(margins.bodyTopY));
  const bottom = Math.min(Math.round(rowTop + pitch.heightPx), Math.floor(margins.bodyBottomY));
  return { x: Math.round(x), y: top, w: Math.round(pitch.widthPx), h: Math.max(1, bottom - top) };
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
 * Finds the column the line numbers are right-aligned against.
 *
 * The margin's own right padding is a theme setting, so the last digit does not
 * end at the gutter's edge - it ends somewhere up to a cell short of it, and
 * reading from the edge samples the padding instead of the digit. Scoring each
 * candidate column by how confidently the cells it implies read as digits
 * measures that padding instead of assuming it.
 */
function findNumberRightEdge(
  image: ImageData,
  margins: MarginBounds,
  pitch: CellPitch,
  digitAtlas: GlyphAtlas,
  rowTops: number[]
): number {
  const probes = rowTops.slice(0, GUTTER_PROBE_ROWS);

  let bestEdge = margins.gutterRightEdgeX;
  let bestScore = -1;

  for (let edge = margins.gutterRightEdgeX; edge > margins.gutterRightEdgeX - pitch.widthPx; edge--) {
    let score = 0;
    for (const top of probes) {
      const match = matchCell(image, cellRect(edge - pitch.widthPx, top, pitch, margins), digitAtlas);
      if (!match.flagged && match.char !== " ") score += match.confidence;
    }
    if (score > bestScore) {
      bestScore = score;
      bestEdge = edge;
    }
  }
  return bestEdge;
}

/** Reads the right-aligned gutter digits for one row by matching cells backward from their right edge. */
function readLineNumber(
  image: ImageData,
  margins: MarginBounds,
  pitch: CellPitch,
  digitAtlas: GlyphAtlas,
  rowTop: number,
  gutterRightEdgeX: number
): { lineNumber: number; confidence: number; isWrappedContinuation: boolean } {
  const { gutterLeftX } = margins;
  const maxSlots = Math.max(0, Math.floor((gutterRightEdgeX - gutterLeftX) / pitch.widthPx));

  const digits: string[] = [];
  const confidences: number[] = [];

  for (let k = 0; k < maxSlots; k++) {
    const rect = cellRect(gutterRightEdgeX - (k + 1) * pitch.widthPx, rowTop, pitch, margins);
    const match = matchCell(image, rect, digitAtlas);

    // Ink decides whether this row has a number; which digit it is decides what
    // the number says. Treating an ambiguous digit as no number at all is the
    // worse error by far - it makes the row a continuation, and its whole line
    // gets glued onto the one above. The ambiguity is recorded in the
    // confidence instead.
    if (match.char === " ") {
      break;
    }
    digits.unshift(match.char);
    confidences.unshift(match.flagged ? Math.min(match.confidence, CONFIDENCE_FLOOR) : match.confidence);
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
 *
 * A row's box is hung from its baseline rather than centered on its ink, because
 * that is how the templates are drawn: a glyph sits on the baseline with the
 * ascent above it. Centering a row on whatever ink it happens to carry would
 * shift every cell in it against the templates by a different amount.
 */
export function buildRows(image: ImageData, margins: MarginBounds, pitch: CellPitch, atlas: GlyphAtlas): LineRow[] {
  const { textAreaLeftX, textAreaRightX } = margins;
  const columnCount = Math.floor((textAreaRightX - textAreaLeftX) / pitch.widthPx);
  const ascent = (atlas.baselineFraction ?? DEFAULT_BASELINE_FRACTION) * pitch.heightPx;

  const rowTops = pitch.rowYCenters.map((yCenter, index) => {
    const baseline = pitch.rowBaselines?.[index];
    return baseline !== undefined ? baseline - ascent : yCenter - pitch.heightPx / 2;
  });
  const digitAtlas = restrictAtlas(atlas, DIGITS);
  const numberRightEdgeX = findNumberRightEdge(image, margins, pitch, digitAtlas, rowTops);

  return rowTops.map((rowTop) => {
    const rowBottom = rowTop + pitch.heightPx;

    const { lineNumber, confidence, isWrappedContinuation } = readLineNumber(
      image,
      margins,
      pitch,
      digitAtlas,
      rowTop,
      numberRightEdgeX
    );

    const cells: CellResult[] = [];
    for (let col = 0; col < columnCount; col++) {
      const rect = cellRect(textAreaLeftX + col * pitch.widthPx, rowTop, pitch, margins);
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
