import { describe, expect, it } from "vitest";
import { applyHomography, computeHomography, estimateAspectRatio, invertHomography, type Point } from "./rectify";

function expectPointClose(a: Point, b: Point, precision = 6) {
  expect(a.x).toBeCloseTo(b.x, precision);
  expect(a.y).toBeCloseTo(b.y, precision);
}

describe("computeHomography / applyHomography", () => {
  it("maps affine (scale + translate) correspondences exactly", () => {
    const src: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const dst: Point[] = [
      { x: 100, y: 200 },
      { x: 300, y: 200 },
      { x: 300, y: 400 },
      { x: 100, y: 400 },
    ];

    const h = computeHomography(src, dst);
    src.forEach((p, i) => expectPointClose(applyHomography(h, p), dst[i]));
  });

  it("maps a genuine perspective (non-affine trapezoid) quad onto a rectangle", () => {
    const src: Point[] = [
      { x: 50, y: 20 },
      { x: 250, y: 40 },
      { x: 260, y: 220 },
      { x: 30, y: 200 },
    ];
    const dst: Point[] = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 300 },
      { x: 0, y: 300 },
    ];

    const h = computeHomography(src, dst);
    src.forEach((p, i) => expectPointClose(applyHomography(h, p), dst[i], 3));
  });

  it("throws on degenerate (collinear) correspondences", () => {
    const src: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];
    const dst: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];
    expect(() => computeHomography(src, dst)).toThrow();
  });
});

describe("invertHomography", () => {
  it("round-trips points through H then H^-1", () => {
    const src: Point[] = [
      { x: 50, y: 20 },
      { x: 250, y: 40 },
      { x: 260, y: 220 },
      { x: 30, y: 200 },
    ];
    const dst: Point[] = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 300 },
      { x: 0, y: 300 },
    ];

    const h = computeHomography(src, dst);
    const hInv = invertHomography(h);

    for (const p of src) {
      const forward = applyHomography(h, p);
      const back = applyHomography(hInv, forward);
      expectPointClose(back, p, 3);
    }
  });
});

describe("estimateAspectRatio", () => {
  it("computes width/height from average opposite-edge lengths", () => {
    const corners: Point[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(estimateAspectRatio(corners)).toBeCloseTo(2, 5);
  });

  it("averages both pairs of opposite edges for a skewed quad", () => {
    // top edge 200, bottom edge 220 -> avg width 210; left edge 100, right edge 100 -> avg height 100
    const corners: Point[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 220, y: 100 },
      { x: -10, y: 100 },
    ];
    expect(estimateAspectRatio(corners)).toBeCloseTo(210 / 100, 1);
  });
});
