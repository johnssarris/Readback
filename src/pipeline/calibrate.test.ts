import { describe, expect, it } from "vitest";
import { calibrateCellPitch } from "./calibrate";
import type { MarginBounds } from "./margins";

/**
 * Builds a synthetic gutter column: 10 lines at a 10px pitch, each with a right-aligned
 * digit blob (6px cell width) — line index 9 gets a 2-digit-wide blob to exercise the
 * digit-count refinement logic.
 */
function buildSyntheticGutter(): { image: ImageData; margins: MarginBounds } {
  const width = 40;
  const height = 100;
  const gutterRightEdgeX = 30;
  const linePitch = 10;
  const cellWidth = 6;

  const data = new Uint8ClampedArray(width * height * 4);
  const setPixel = (x: number, y: number, gray: number) => {
    const i = (y * width + x) * 4;
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
    data[i + 3] = 255;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) setPixel(x, y, 250); // background
  }

  for (let line = 0; line < 10; line++) {
    const digitCount = line === 9 ? 2 : 1;
    const blobWidth = digitCount * cellWidth;
    const yStart = line * linePitch + 2;
    const yEnd = line * linePitch + 8;
    const xStart = gutterRightEdgeX - blobWidth;

    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < gutterRightEdgeX; x++) {
        setPixel(x, y, 30); // ink
      }
    }
  }

  const image = { width, height, data, colorSpace: "srgb" } as ImageData;
  const margins: MarginBounds = {
    bodyTopY: 0,
    bodyBottomY: height,
    gutterLeftX: 0,
    gutterRightEdgeX,
    textAreaLeftX: gutterRightEdgeX,
    textAreaRightX: width,
  };

  return { image, margins };
}

describe("calibrateCellPitch", () => {
  it("detects one row band per gutter line", () => {
    const { image, margins } = buildSyntheticGutter();
    const result = calibrateCellPitch(image, margins);
    expect(result.rowYCenters.length).toBe(10);
  });

  it("derives the line pitch as the cell height", () => {
    const { image, margins } = buildSyntheticGutter();
    const result = calibrateCellPitch(image, margins);
    expect(result.heightPx).toBeCloseTo(10, 0);
  });

  it("derives the per-character cell width, refining through multi-digit rows", () => {
    const { image, margins } = buildSyntheticGutter();
    const result = calibrateCellPitch(image, margins);
    expect(result.widthPx).toBeCloseTo(6, 0);
  });
});
