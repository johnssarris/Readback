import { calibrateCellPitch, type CellPitch } from "./calibrate";
import { detectMargins, type Framing, type MarginBounds } from "./margins";
import type { GlyphAtlas } from "./match";
import type { OutputSizing } from "./rectify";
import { buildRows, type LineRow } from "../model/lineIndex";

/**
 * How big every capture is rectified to, in the app and in the metrics run
 * alike. See OutputSizing.
 */
export const RECTIFIED_SIZING: OutputSizing = { kind: "fixed", width: 1600 };

export interface Analysis {
  margins: MarginBounds | null;
  pitch: CellPitch | null;
  /** Null when recognition could not run: no atlas, or no usable grid. */
  rows: LineRow[] | null;
  /** What was found, a line per fact, for the result screen. */
  summary: string[];
}

/**
 * Everything read from a rectified capture: where the body is, the character
 * grid, and the text in it.
 *
 * Only ever given the rectified pixels themselves, and never writes to them.
 * Whatever is drawn to show the result - the grid, the margins - goes on a
 * layer of its own; drawn onto these pixels it would be read back as ink, and
 * the first row and every blank cell next to a grid line would come back as
 * something they are not.
 */
export function analyzeCapture(image: ImageData, framing: Framing, atlas: GlyphAtlas | null): Analysis {
  const summary: string[] = [];
  let margins: MarginBounds | null = null;
  let pitch: CellPitch | null = null;

  try {
    margins = detectMargins(image, framing);
    summary.push(`body: y ${margins.bodyTopY}–${margins.bodyBottomY}`);
    summary.push(`gutter edge: x=${margins.gutterRightEdgeX}, text right: x=${margins.textAreaRightX}`);

    pitch = calibrateCellPitch(image, margins);
    summary.push(
      `cell pitch: ${pitch.widthPx.toFixed(1)} x ${pitch.heightPx.toFixed(1)} px, rows detected: ${pitch.rowYCenters.length}`
    );
    if (!usable(pitch)) {
      summary.push("grid not drawn: calibration did not resolve a usable cell pitch");
      pitch = null;
    }
  } catch (err) {
    summary.push(`pipeline error: ${(err as Error).message}`);
    margins = null;
    pitch = null;
  }

  const rows = margins && pitch && atlas ? buildRows(image, margins, pitch, atlas) : null;
  return { margins, pitch, rows, summary };
}

function usable(pitch: CellPitch): boolean {
  return Number.isFinite(pitch.widthPx) && pitch.widthPx > 0 && Number.isFinite(pitch.heightPx) && pitch.rowYCenters.length > 0;
}
