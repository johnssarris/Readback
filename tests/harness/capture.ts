import { bilinearGraySample, luminance, median } from "../../src/pipeline/imageUtils";
import { ARM, THICK } from "../../src/pipeline/markerGeometry";
import { applyHomography, cameraPxPerScreenPx, computeHomography, type Point } from "../../src/pipeline/rectify";

/**
 * What a capture was like as a photograph, measured in screen pixels.
 *
 * The corners say where the pane is; the pane's size on screen says how many
 * screen pixels lie between them. Together they map any point on the screen to
 * where the camera put it, so anything drawn at a known place - the markers'
 * edges, the pane's own boundaries - can be looked up in the photograph and
 * compared with what was drawn. None of this changes what the pipeline does;
 * it is here so a change to the capture can be judged by more than its CER.
 *
 * The marker geometry is taken at 100% display scaling, which is what the
 * captures were made at (tools/README.md).
 */
export interface CaptureMeasures {
  /** Camera pixels per screen pixel, averaged over the pane's area. */
  density: number;
  /** Median 10-90% rise across the markers' inner edges, in screen pixels. */
  blurPx: number | null;
  /**
   * How far the middle of the pane's top and bottom boundaries sits from
   * where the straight line between their ends puts it, in screen pixels.
   * Positive is toward the inside of the pane. Null where the boundary had
   * too little contrast with what is outside it to find.
   */
  bowPx: { top: number | null; bottom: number | null };
}

export function measureCapture(image: ImageData, corners: Point[], pane: { width: number; height: number }): CaptureMeasures {
  const { width: W, height: H } = pane;
  const toImage = computeHomography(
    [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ],
    corners
  );

  const gray = new Float32Array(image.width * image.height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = luminance(image.data[p], image.data[p + 1], image.data[p + 2]);
  }
  const at = (x: number, y: number) => {
    const p = applyHomography(toImage, { x, y });
    return bilinearGraySample(gray, image.width, image.height, p.x, p.y);
  };

  return {
    density: cameraPxPerScreenPx(corners, pane),
    blurPx: markerBlur(at, W, H),
    bowPx: { top: boundaryBow(at, W, 0, 1), bottom: boundaryBow(at, W, H, -1) },
  };
}

/** Step, in screen pixels, at which profiles across an edge are sampled. */
const PROFILE_STEP = 0.05;

/** How far into the white a profile across a marker edge runs, past the edge. */
const WHITE_REACH = 12;

/** Clearance from the ends of an arm, where the other arm or the tip rounds the edge off. */
const ARM_CLEARANCE = 4;

/**
 * The blur of the shot, from the markers' inner edges.
 *
 * Each L's two inner edges face the white of its own empty quadrant, ARM less
 * THICK across - the one place on screen where a known black edge has a known
 * stretch of white beside it and nothing else. The outer edges have only the
 * tile's margin, and the pane side has the first line of text a few pixels
 * off. Both inner edges are read, so blur along either axis shows.
 */
function markerBlur(at: (x: number, y: number) => number, W: number, H: number): number | null {
  const rises: number[] = [];
  for (const [cx, cy, sx, sy] of [
    [0, 0, 1, -1],
    [W, 0, -1, -1],
    [W, H, -1, 1],
    [0, H, 1, 1],
  ]) {
    for (let t = THICK + ARM_CLEARANCE; t <= ARM - ARM_CLEARANCE; t += 2) {
      // Across the horizontal arm's inner edge, then the upright arm's.
      const horizontal = riseAcross((s) => at(cx + sx * t, cy + sy * s));
      const upright = riseAcross((s) => at(cx + sx * s, cy + sy * t));
      if (horizontal !== null) rises.push(horizontal);
      if (upright !== null) rises.push(upright);
    }
  }
  return rises.length > 0 ? median(rises) : null;
}

/**
 * The 10-90% rise of one profile that runs from the middle of an arm, out past
 * its inner edge into the white. `sample(s)` is the brightness s screen pixels
 * out from the arm's outer edge.
 */
function riseAcross(sample: (s: number) => number): number | null {
  const from = THICK / 2;
  const to = THICK + WHITE_REACH;
  const values: number[] = [];
  for (let s = from; s <= to; s += PROFILE_STEP) values.push(sample(s));

  const black = values[0];
  const white = median(values.slice(Math.floor(values.length * 0.75)));
  if (!(white - black > 40)) return null;

  const crossing = (fraction: number) => {
    const level = black + (white - black) * fraction;
    for (let i = 1; i < values.length; i++) {
      if (values[i] >= level) {
        const f = (level - values[i - 1]) / (values[i] - values[i - 1] || 1);
        return from + (i - 1 + f) * PROFILE_STEP;
      }
    }
    return null;
  };
  const low = crossing(0.1);
  const high = crossing(0.9);
  return low !== null && high !== null ? high - low : null;
}

/** Spacing, in screen pixels, of the profiles taken across a pane boundary. */
const BOUNDARY_STEP = 8;

/** How far either side of a boundary its profile reaches. */
const BOUNDARY_REACH = 6;

/** Least difference between the page and what is outside it for a boundary to be read at a place. */
const BOUNDARY_CONTRAST = 40;

/** Profiles further than this from the fitted curve are something drawn there, not the boundary. */
const BOUNDARY_OUTLIER_PX = 1.5;

/**
 * How much a horizontal pane boundary bows, from where the page meets the
 * chrome along its whole length.
 *
 * Each profile runs across the boundary from outside to in, and the boundary is
 * where it crosses halfway between the two. A parabola through those, refitted
 * without whatever the tab labels or the status text pulled off it, says how
 * far the middle is from the line between the ends. The stretches under the
 * markers are left out: there the boundary is the marker's own edge.
 */
function boundaryBow(at: (x: number, y: number) => number, W: number, y: number, inward: number): number | null {
  const clear = ARM + 10;
  const points: Array<{ u: number; d: number }> = [];
  for (let x = clear; x <= W - clear; x += BOUNDARY_STEP) {
    const values: number[] = [];
    for (let s = -BOUNDARY_REACH; s <= BOUNDARY_REACH; s += PROFILE_STEP) values.push(at(x, y + inward * s));

    const quarter = Math.floor(values.length / 4);
    const outside = median(values.slice(0, quarter));
    const inside = median(values.slice(values.length - quarter));
    if (!(inside - outside > BOUNDARY_CONTRAST)) continue;

    const level = (outside + inside) / 2;
    const i = values.findIndex((v) => v >= level);
    if (i <= 0) continue;
    const f = (level - values[i - 1]) / (values[i] - values[i - 1] || 1);
    points.push({ u: (2 * x) / W - 1, d: -BOUNDARY_REACH + (i - 1 + f) * PROFILE_STEP });
  }

  let kept = points;
  for (let pass = 0; pass < 3; pass++) {
    const fit = fitParabola(kept);
    if (!fit) return null;
    const next = kept.filter((p) => Math.abs(fit.a + fit.b * p.u + fit.c * p.u * p.u - p.d) <= BOUNDARY_OUTLIER_PX);
    if (next.length === kept.length || next.length < MIN_BOUNDARY_POINTS) {
      // The chord through the ends is a + c at u = 0; the middle is a.
      return -fit.c;
    }
    kept = next;
  }
  const fit = fitParabola(kept);
  return fit ? -fit.c : null;
}

/** Fewer profiles than this across a boundary say nothing about its shape. */
const MIN_BOUNDARY_POINTS = 12;

/** Least squares d = a + b u + c u^2. */
function fitParabola(points: Array<{ u: number; d: number }>): { a: number; b: number; c: number } | null {
  if (points.length < MIN_BOUNDARY_POINTS) return null;
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0,
    t0 = 0,
    t1 = 0,
    t2 = 0;
  for (const { u, d } of points) {
    const u2 = u * u;
    s0 += 1;
    s1 += u;
    s2 += u2;
    s3 += u2 * u;
    s4 += u2 * u2;
    t0 += d;
    t1 += d * u;
    t2 += d * u2;
  }
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [
    [s0, s1, s2],
    [s1, s2, s3],
    [s2, s3, s4],
  ];
  const D = det(M);
  if (Math.abs(D) < 1e-9) return null;
  const withColumn = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? [t0, t1, t2][i] : v)));
  return { a: det(withColumn(0)) / D, b: det(withColumn(1)) / D, c: det(withColumn(2)) / D };
}
