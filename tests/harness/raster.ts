import type { OverlayContext } from "../../src/capture/debugOverlay";

/**
 * A 2D context that paints the overlay's strokes into an ImageData, the way
 * the old code painted them into the capture. Axis-aligned lines are all the
 * overlay draws, so that is all this rasterizes.
 */
export class RasterContext implements OverlayContext {
  lineWidth = 1;
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000";
  private path: Array<[number, number, number, number]> = [];
  private at: [number, number] = [0, 0];
  private saved: Array<[number, typeof this.strokeStyle]> = [];

  private image: ImageData;

  constructor(image: ImageData) {
    this.image = image;
  }

  save() {
    this.saved.push([this.lineWidth, this.strokeStyle]);
  }
  restore() {
    [this.lineWidth, this.strokeStyle] = this.saved.pop()!;
  }
  beginPath() {
    this.path = [];
  }
  moveTo(x: number, y: number) {
    this.at = [x, y];
  }
  lineTo(x: number, y: number) {
    this.path.push([this.at[0], this.at[1], x, y]);
    this.at = [x, y];
  }
  stroke() {
    const [r, g, b, a] = parseColor(String(this.strokeStyle));
    const { width, height, data } = this.image;
    const half = this.lineWidth / 2;
    for (const [x0, y0, x1, y1] of this.path) {
      const left = Math.max(0, Math.round(Math.min(x0, x1) - (x0 === x1 ? half : 0)));
      const right = Math.min(width, Math.round(Math.max(x0, x1) + (x0 === x1 ? half : 0)));
      const top = Math.max(0, Math.round(Math.min(y0, y1) - (y0 === y1 ? half : 0)));
      const bottom = Math.min(height, Math.round(Math.max(y0, y1) + (y0 === y1 ? half : 0)));
      for (let y = top; y < Math.max(bottom, top + 1) && y < height; y++) {
        for (let x = left; x < Math.max(right, left + 1) && x < width; x++) {
          const i = (y * width + x) * 4;
          data[i] = data[i] * (1 - a) + r * a;
          data[i + 1] = data[i + 1] * (1 - a) + g * a;
          data[i + 2] = data[i + 2] * (1 - a) + b * a;
        }
      }
    }
  }
}

function parseColor(style: string): [number, number, number, number] {
  const rgba = style.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], +rgba[4]];
  const hex = style.replace("#", "");
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
}
