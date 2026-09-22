import { describe, expect, it } from "vitest";
import {
  applyHomography,
  chooseOutputSize,
  computeHomography,
  estimateAspectRatio,
  invertHomography,
  MAX_OUTPUT_PIXELS,
  MAX_OUTPUT_WIDTH,
  normalizeQuad,
  type Point,
} from "./rectify";

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

describe("normalizeQuad", () => {
  const tl = { x: 100, y: 80 };
  const tr = { x: 900, y: 120 };
  const br = { x: 860, y: 600 };
  const bl = { x: 130, y: 560 };

  it("returns a clockwise quad from the markers exactly as given", () => {
    const quad = [tl, tr, br, bl];
    expect(normalizeQuad(quad)).toEqual(quad);
  });

  it("keeps a clockwise quad as given even when it is turned well past square", () => {
    // Rotated about 40 degrees: the top-left corner is no longer the one
    // nearest the image's top left, and must not be relabelled.
    const quad = [
      { x: 400, y: 100 },
      { x: 900, y: 520 },
      { x: 560, y: 900 },
      { x: 80, y: 480 },
    ];
    expect(normalizeQuad(quad)).toEqual(quad);
  });

  it("puts counter-clockwise corners back in order", () => {
    expect(normalizeQuad([tl, bl, br, tr])).toEqual([tl, tr, br, bl]);
  });

  it("starts a reordered quad from the top left whichever corner came first", () => {
    expect(normalizeQuad([br, tr, tl, bl])).toEqual([tl, tr, br, bl]);
  });

  it("untangles two swapped corners (a bowtie)", () => {
    expect(normalizeQuad([tl, tr, bl, br])).toEqual([tl, tr, br, bl]);
  });

  it("rejects points that are not a quad in any order", () => {
    expect(normalizeQuad([tl, { x: 500, y: 100 }, tr, br])).toBeNull(); // three nearly in a line
    expect(normalizeQuad([tl, tr, br, { x: 500, y: 300 }])).toBeNull(); // one inside the other three
    expect(normalizeQuad([tl, tl, br, bl])).toBeNull(); // two the same
  });
});

describe("chooseOutputSize", () => {
  // A pane photographed 900 across at the top and 820 at the bottom, 500 and
  // 480 down its sides.
  const quad = [
    { x: 100, y: 100 },
    { x: 1000, y: 100 },
    { x: 960, y: 580 },
    { x: 140, y: 600 },
  ];
  const across = 900;

  it("keeps the old fixed width when asked to", () => {
    expect(chooseOutputSize(quad, 1.75, { kind: "fixed", width: 1600 })).toEqual({ width: 1600, height: 914, clamped: false });
  });

  it("follows the longer edge of the photograph, so no row is squeezed", () => {
    const size = chooseOutputSize(quad, 1.75, { kind: "source", oversample: 1 });
    expect(size.width).toBe(across);
    expect(size.height).toBe(Math.round(across / 1.75));
    expect(chooseOutputSize(quad, 1.75, { kind: "source", oversample: 1.5 }).width).toBe(across * 1.5);
  });

  it("follows the longer side instead when the aspect makes that the bigger pane", () => {
    // The right side, 40 across and 520 down, at 2.0 wide-to-high is about
    // 1043 across - more than the 900 seen.
    const tall = [quad[0], quad[1], { x: 960, y: 620 }, { x: 140, y: 620 }];
    expect(chooseOutputSize(tall, 2, { kind: "source", oversample: 1 }).width).toBe(Math.round(Math.hypot(40, 520) * 2));
  });

  it("lays a known pane out at its own size, wherever it was photographed from", () => {
    const size = chooseOutputSize(quad, 985 / 563, { kind: "source", oversample: 1.5, paneSize: { width: 985, height: 563 } });
    expect(size).toEqual({ width: 1478, height: 845, clamped: false });
  });

  it("caps the size a phone has to hold", () => {
    const wide = chooseOutputSize(quad, 1.75, { kind: "source", oversample: 10 });
    expect(wide.clamped).toBe(true);
    expect(wide.width).toBeLessThanOrEqual(MAX_OUTPUT_WIDTH);
    expect(wide.width * wide.height).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS * 1.001);

    const tall = chooseOutputSize(quad, 0.5, { kind: "source", oversample: 10 });
    expect(tall.clamped).toBe(true);
    expect(tall.width * tall.height).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS * 1.001);
    expect(Math.abs(tall.width / tall.height - 0.5)).toBeLessThan(0.01);
  });
});
