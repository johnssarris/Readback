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

/**
 * A gutter plus text laid out on a known grid, with the text starting some way
 * past the gutter's edge - the left padding a theme adds, which is exactly what
 * the grid's origin must not assume away.
 */
function buildSyntheticBody(padding: number): { image: ImageData; margins: MarginBounds; cellWidth: number } {
  const width = 300;
  const height = 160;
  const gutterRightEdgeX = 30;
  const linePitch = 16;
  const cellWidth = 8; // half the line box, as a real monospace cell is
  const textLeft = gutterRightEdgeX + padding;

  const data = new Uint8ClampedArray(width * height * 4);
  const setPixel = (x: number, y: number, gray: number) => {
    const i = (y * width + x) * 4;
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
    data[i + 3] = 255;
  };

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) setPixel(x, y, 250);

  for (let line = 0; line < 10; line++) {
    const yStart = line * linePitch + 3;
    const yEnd = line * linePitch + 13;

    // Line number: one digit, right-aligned against the gutter's inner edge.
    for (let y = yStart; y < yEnd; y++) {
      for (let x = gutterRightEdgeX - 8; x < gutterRightEdgeX - 2; x++) setPixel(x, y, 30);
    }

    // Text: ink in the middle of each cell, so every cell boundary is a gap.
    for (let col = 0; col < 30; col++) {
      const x0 = textLeft + col * cellWidth;
      if (x0 + cellWidth > width) break;
      for (let y = yStart; y < yEnd; y++) {
        for (let x = x0 + 2; x < x0 + cellWidth - 1; x++) setPixel(x, y, 30);
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
  return { image, margins, cellWidth };
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

  it("reports no cell width for a screenful with no text on it", () => {
    // The line numbers cannot stand in for the text: the margin's font is a
    // setting of its own, and its advance need not be the text's at all.
    const { image, margins } = buildSyntheticGutter();
    const result = calibrateCellPitch(image, margins);
    expect(Number.isNaN(result.widthPx)).toBe(true);
  });

  it("puts the grid's origin where the text starts, not where the gutter ends", () => {
    // The editor's left padding is a theme setting. Taking the gutter's edge as
    // the first column offsets every cell in every row by whatever it is.
    const padding = 5;
    const { image, margins, cellWidth } = buildSyntheticBody(padding);
    const result = calibrateCellPitch(image, margins);

    expect(result.widthPx).toBeCloseTo(cellWidth, 0);
    expect(result.columnOriginX).toBeCloseTo(margins.gutterRightEdgeX + padding, 0);
  });

  it("finds the same grid when the editor has no left padding", () => {
    const { image, margins, cellWidth } = buildSyntheticBody(0);
    const result = calibrateCellPitch(image, margins);

    expect(result.widthPx).toBeCloseTo(cellWidth, 0);
    expect(result.columnOriginX).toBeCloseTo(margins.gutterRightEdgeX, 0);
  });
});
