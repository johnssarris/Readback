import { describe, expect, it } from "vitest";
import { detectMargins } from "./margins";

/** Builds a synthetic rectified-window image: tab bar, editor body (gutter + text), status bar. */
function buildSyntheticWindow(): ImageData {
  const width = 200;
  const height = 150;
  const tabBarHeight = 10;
  const statusBarHeight = 20;
  const gutterWidth = 30;

  const data = new Uint8ClampedArray(width * height * 4);

  const setPixel = (x: number, y: number, gray: number) => {
    const i = (y * width + x) * 4;
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
    data[i + 3] = 255;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < tabBarHeight || y >= height - statusBarHeight) {
        setPixel(x, y, 60); // dark chrome
      } else if (x < gutterWidth) {
        setPixel(x, y, 200); // gutter grey
      } else {
        setPixel(x, y, 250); // text background
      }
    }
  }

  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

describe("detectMargins", () => {
  it("locates the editor body between the tab bar and status bar", () => {
    const image = buildSyntheticWindow();
    const margins = detectMargins(image);

    expect(margins.bodyTopY).toBeGreaterThanOrEqual(8);
    expect(margins.bodyTopY).toBeLessThanOrEqual(12);
    expect(margins.bodyBottomY).toBeGreaterThanOrEqual(128);
    expect(margins.bodyBottomY).toBeLessThanOrEqual(132);
  });

  it("locates the gutter/text-area boundary", () => {
    const image = buildSyntheticWindow();
    const margins = detectMargins(image);

    expect(margins.gutterRightEdgeX).toBeGreaterThanOrEqual(28);
    expect(margins.gutterRightEdgeX).toBeLessThanOrEqual(33);
    expect(margins.textAreaLeftX).toBe(margins.gutterRightEdgeX);
  });

  it("falls back to full width when no scrollbar boundary is present", () => {
    const image = buildSyntheticWindow();
    const margins = detectMargins(image);
    expect(margins.textAreaRightX).toBe(image.width);
  });
});
