import type { CellPitch } from "../pipeline/calibrate";
import type { MarginBounds } from "../pipeline/margins";

/** The drawing calls the overlay makes, so a test can hand it something that only records them. */
export type OverlayContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "lineWidth" | "strokeStyle"
>;

/**
 * Draws the detected body, gutter and character grid, for checking alignment
 * by eye.
 *
 * Takes the context of the transparent layer over the result, never of the
 * rectified pixels: the analysis has already run by the time this draws, but a
 * line here is darker than the page and as dark as a faint glyph, and on the
 * pixels themselves it would be read as text.
 */
export function drawDebugOverlay(
  ctx: OverlayContext,
  size: { width: number; height: number },
  margins: MarginBounds,
  pitch: CellPitch | null
): void {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#f97316";
  ctx.beginPath();
  ctx.moveTo(0, margins.bodyTopY);
  ctx.lineTo(size.width, margins.bodyTopY);
  ctx.moveTo(0, margins.bodyBottomY);
  ctx.lineTo(size.width, margins.bodyBottomY);
  ctx.stroke();

  ctx.strokeStyle = "#22d3ee";
  ctx.beginPath();
  ctx.moveTo(margins.gutterRightEdgeX, margins.bodyTopY);
  ctx.lineTo(margins.gutterRightEdgeX, margins.bodyBottomY);
  ctx.moveTo(margins.textAreaRightX, margins.bodyTopY);
  ctx.lineTo(margins.textAreaRightX, margins.bodyBottomY);
  ctx.stroke();

  if (pitch) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(56, 189, 248, 0.5)";
    ctx.beginPath();
    for (const yCenter of pitch.rowYCenters) {
      const top = yCenter - pitch.heightPx / 2;
      ctx.moveTo(pitch.columnOriginX, top);
      ctx.lineTo(margins.textAreaRightX, top);
    }
    for (let x = pitch.columnOriginX; x < margins.textAreaRightX; x += pitch.widthPx) {
      ctx.moveTo(x, margins.bodyTopY);
      ctx.lineTo(x, margins.bodyBottomY);
    }
    ctx.stroke();
  }
  ctx.restore();
}
