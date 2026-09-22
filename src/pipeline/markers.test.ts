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

interface SceneOptions {
  omit?: Corner;
  /**
   * Draw the markers' arms a pixel thinner than they were drawn on screen,
   * which is what a photograph does to them: blurred, compressed and then
   * thresholded well down into the black, they come back eroded. Enough to put
   * their fill below an L's exact share, so anything crisp out-scores them.
   */
  eroded?: boolean;
  /** Crisp L-shaped ink inside the pane, one naming each corner, at this arm length. */
  decoyArm?: number;
}

/**
 * A window with the pane's corners marked, drawn the way the overlay draws
 * them: an L on a white tile, its outer corner on the pane corner, outside the
 * pane so it covers nothing.
 */
function buildScene(options: SceneOptions = {}): Scene {
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

  /**
   * One L, its outer corner at (cornerX, cornerY) and its arms running away
   * from it. Thinning `t` keeps both outer edges where they are, so an eroded
   * marker still names the same point.
   */
  const drawL = (corner: Corner, cornerX: number, cornerY: number, a: number, t: number) => {
    const top = corner[0] === "t";
    const left = corner[1] === "l";
    // The box the L occupies: it extends away from the pane, so up from a top
    // marker's corner and down from a bottom one's.
    const boxX = left ? cornerX : cornerX - a;
    const boxY = top ? cornerY - a : cornerY;
    const armY = top ? boxY + a - t : boxY;
    const armX = left ? boxX : boxX + a - t;
    fill(boxX, armY, boxX + a, armY + t, INK);
    fill(armX, boxY, armX + t, boxY + a, INK);
  };

  fill(0, 0, WIDTH, HEIGHT, CHROME);
  fill(pane.left, pane.top, pane.right, pane.bottom, PAGE);

  const m = MARGIN;
  const thick = options.eroded ? THICK - 1 : THICK;

  for (const corner of ["tl", "tr", "bl", "br"] as Corner[]) {
    if (options.omit === corner) continue;

    const top = corner[0] === "t";
    const left = corner[1] === "l";
    const cornerX = left ? pane.left : pane.right;
    const cornerY = top ? pane.top : pane.bottom;

    const originX = left ? pane.left - m : pane.right - ARM - m;
    const originY = top ? pane.top - ARM - m : pane.bottom;
    fill(originX, originY, originX + ARM + 2 * m, originY + ARM + m, 255);

    drawL(corner, cornerX, cornerY, ARM, thick);
  }

  // Ink inside the pane that is an L in its own right - which text is full of.
  // Drawn to an L's exact proportions and perfectly crisp, so each one scores
  // better on its own than any of the four markers around it.
  if (options.decoyArm) {
    const a = options.decoyArm;
    const t = Math.round((a * THICK) / ARM);
    const inset = 40;
    const spots: Array<[Corner, number, number]> = [
      ["tl", pane.left + inset, pane.top + inset],
      ["tr", pane.right - inset, pane.top + inset],
      ["br", pane.right - inset, pane.bottom - inset],
      ["bl", pane.left + inset, pane.bottom - inset],
    ];
    for (const [corner, x, y] of spots) drawL(corner, x, y, a, t);
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

  it("picks the markers over crisper L-shaped ink inside the pane", () => {
    // The photographed case, in miniature: four eroded markers around the pane
    // and four perfect little L's within it, one naming each corner. Judged one
    // at a time the decoys win every corner - they are exactly an L's
    // proportions and the markers are not - and the four of them form a
    // convex, evenly sized, well spread quad of their own.
    const { image, pane } = buildScene({ eroded: true, decoyArm: 15 });
    const quad = detectMarkerQuad(image);

    expect(quad).not.toBeNull();
    const [tl, , br] = quad!.corners;
    expect(tl.x).toBeCloseTo(pane.left, 0);
    expect(tl.y).toBeCloseTo(pane.top, 0);
    expect(br.x).toBeCloseTo(pane.right, 0);
    expect(br.y).toBeCloseTo(pane.bottom, 0);
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
