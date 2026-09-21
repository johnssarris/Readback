import { describe, expect, it } from "vitest";
import { detectMarkerQuad } from "./markers";
import { ARM, MARGIN, THICK, type Corner } from "./markerGeometry";
import { applyHomography, computeHomography, warpImageData, type Point } from "./rectify";

const WIDTH = 400;
const HEIGHT = 300;
const CHROME = 60;
const PAGE = 250;
const INK = 10;

interface Scene {
  image: ImageData;
  pane: { left: number; top: number; right: number; bottom: number };
}

/**
 * A window with the pane's corners marked, drawn the way the overlay draws
 * them: an L on a white tile, its outer corner on the pane corner, outside the
 * pane so it covers nothing.
 */
function buildScene(options: { omit?: Corner } = {}): Scene {
  const pane = { left: 60, top: 60, right: WIDTH - 60, bottom: HEIGHT - 60 };
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);

  const fill = (x0: number, y0: number, x1: number, y1: number, gray: number) => {
    for (let y = Math.max(0, y0); y < Math.min(HEIGHT, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(WIDTH, x1); x++) {
        const i = (y * WIDTH + x) * 4;
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        data[i + 3] = 255;
      }
    }
  };

  fill(0, 0, WIDTH, HEIGHT, CHROME);
  fill(pane.left, pane.top, pane.right, pane.bottom, PAGE);

  const a = ARM;
  const t = THICK;
  const m = MARGIN;

  for (const corner of ["tl", "tr", "bl", "br"] as Corner[]) {
    if (options.omit === corner) continue;

    const top = corner[0] === "t";
    const left = corner[1] === "l";

    const originX = left ? pane.left - m : pane.right - a - m;
    const originY = top ? pane.top - a - m : pane.bottom;
    fill(originX, originY, originX + a + 2 * m, originY + a + m, 255);

    const x0 = m;
    const y0 = top ? m : 0;
    const armY = top ? y0 + a - t : y0;
    const armX = left ? x0 : x0 + a - t;
    fill(originX + x0, originY + armY, originX + x0 + a, originY + armY + t, INK);
    fill(originX + armX, originY + y0, originX + armX + t, originY + y0 + a, INK);
  }

  return { image: { width: WIDTH, height: HEIGHT, data, colorSpace: "srgb" } as ImageData, pane };
}

/** Redraws a scene as though photographed from an angle. */
function placeInto(source: ImageData, from: Point[], to: Point[], width: number, height: number): ImageData {
  const frame: Point[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const back = computeHomography(to, from);
  const quadInSource = frame.map((p) => applyHomography(back, p));
  const warped = warpImageData(source, source.width, source.height, quadInSource, width, height);

  // Outside the scene, desk rather than a smear of its edge pixels.
  const h = computeHomography(from, to);
  const corners = from.map((p) => applyHomography(h, p));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let inside = true;
      for (let i = 0; i < 4 && inside; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        if ((b.x - a.x) * (y + 0.5 - a.y) - (b.y - a.y) * (x + 0.5 - a.x) < 0) inside = false;
      }
      if (!inside) {
        const i = (y * width + x) * 4;
        warped.data[i] = 30;
        warped.data[i + 1] = 30;
        warped.data[i + 2] = 34;
        warped.data[i + 3] = 255;
      }
    }
  }
  return { width, height, data: warped.data, colorSpace: "srgb" } as ImageData;
}

describe("detectMarkerQuad", () => {
  it("returns the pane's corners", () => {
    const { image, pane } = buildScene();
    const quad = detectMarkerQuad(image);

    expect(quad).not.toBeNull();
    const [tl, tr, br, bl] = quad!.corners;
    expect(tl.x).toBeCloseTo(pane.left, 0);
    expect(tl.y).toBeCloseTo(pane.top, 0);
    expect(tr.x).toBeCloseTo(pane.right, 0);
    expect(tr.y).toBeCloseTo(pane.top, 0);
    expect(br.x).toBeCloseTo(pane.right, 0);
    expect(br.y).toBeCloseTo(pane.bottom, 0);
    expect(bl.x).toBeCloseTo(pane.left, 0);
    expect(bl.y).toBeCloseTo(pane.bottom, 0);
  });

  it("gives up when one marker is missing, rather than guessing a quad", () => {
    expect(detectMarkerQuad(buildScene({ omit: "br" }).image)).toBeNull();
  });

  it("still names the corners when the shot is tilted", () => {
    // Shot from an angle, steeply enough that the pane is a proper
    // quadrilateral rather than a rectangle. The corners must still come back
    // in order, each one on the right corner of the tilted pane.
    const { image, pane } = buildScene();
    const flat = [
      { x: 0, y: 0 },
      { x: WIDTH, y: 0 },
      { x: WIDTH, y: HEIGHT },
      { x: 0, y: HEIGHT },
    ];
    const tilted = [
      { x: 90, y: 40 },
      { x: 760, y: 120 },
      { x: 700, y: 560 },
      { x: 40, y: 470 },
    ];
    const warped = placeInto(image, flat, tilted, 820, 620);

    const quad = detectMarkerQuad(warped);
    expect(quad).not.toBeNull();

    const h = computeHomography(flat, tilted);
    const want = [
      applyHomography(h, { x: pane.left, y: pane.top }),
      applyHomography(h, { x: pane.right, y: pane.top }),
      applyHomography(h, { x: pane.right, y: pane.bottom }),
      applyHomography(h, { x: pane.left, y: pane.bottom }),
    ];
    // Within a few pixels on an 80px marker: the tilt resamples the scene to
    // twice its size, which softens every edge the fit runs along.
    quad!.corners.forEach((corner, i) => {
      expect(Math.hypot(corner.x - want[i].x, corner.y - want[i].y)).toBeLessThan(3);
    });
  });

  it("finds nothing in a window with no markers on it", () => {
    const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      const gray = i % WIDTH > 60 && i % WIDTH < WIDTH - 60 ? PAGE : CHROME;
      data[i * 4] = gray;
      data[i * 4 + 1] = gray;
      data[i * 4 + 2] = gray;
      data[i * 4 + 3] = 255;
    }
    expect(detectMarkerQuad({ width: WIDTH, height: HEIGHT, data, colorSpace: "srgb" } as ImageData)).toBeNull();
  });
});
