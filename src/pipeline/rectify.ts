export interface Point {
  x: number;
  y: number;
}

/** A 3x3 homography matrix stored row-major as 9 numbers. */
export type Homography = number[];

/**
 * Solves for the 3x3 homography H (row-major, h[8] = 1) that maps each
 * src[i] to dst[i], using the standard 4-point DLT linear system
 * (8 equations, 8 unknowns, solved by Gaussian elimination).
 */
export function computeHomography(src: Point[], dst: Point[]): Homography {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error("computeHomography requires exactly 4 point correspondences");
  }

  // Build the 8x8 system A*h = b for unknowns [h11,h12,h13,h21,h22,h23,h31,h32].
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];

    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);

    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }

  const h = solveLinearSystem(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Solves Ax = b for a square system via Gaussian elimination with partial pivoting. */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivotRow][col])) {
        pivotRow = row;
      }
    }
    if (pivotRow !== col) {
      [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    }

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) {
      throw new Error("Singular matrix: corner points are degenerate (collinear or duplicated)");
    }

    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / pivot;
      for (let k = col; k <= n; k++) {
        M[row][k] -= factor * M[col][k];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let k = row + 1; k < n; k++) {
      sum -= M[row][k] * x[k];
    }
    x[row] = sum / M[row][row];
  }
  return x;
}

/** Inverts a 3x3 homography (row-major) via the adjugate/determinant method. */
export function invertHomography(h: Homography): Homography {
  const [a, b, c, d, e, f, g, i, j] = h;

  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const D = -(b * j - c * i);
  const E = a * j - c * g;
  const F = -(a * i - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;

  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) {
    throw new Error("Homography is singular and cannot be inverted");
  }

  const invDet = 1 / det;
  return [A * invDet, D * invDet, G * invDet, B * invDet, E * invDet, H * invDet, C * invDet, F * invDet, I * invDet];
}

/** Applies a homography to a single point. */
export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/**
 * Warps pixel data (mapping its `srcCorners` quad to a flat destWidth x destHeight
 * rectangle), via inverse mapping + bilinear sampling. Returns raw pixels rather
 * than a canvas, so this runs anywhere — including the metrics harness, which has
 * no DOM.
 */
export function warpImageData(
  srcData: ImageData,
  sourceWidth: number,
  sourceHeight: number,
  srcCorners: Point[],
  destWidth: number,
  destHeight: number
): { width: number; height: number; data: Uint8ClampedArray } {
  const dstCorners: Point[] = [
    { x: 0, y: 0 },
    { x: destWidth, y: 0 },
    { x: destWidth, y: destHeight },
    { x: 0, y: destHeight },
  ];

  const forward = computeHomography(srcCorners, dstCorners);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = invertHomography(forward);
  const src = srcData.data;

  // Inverse mapping, one row at a time: the three homogeneous coordinates are
  // linear along a row, so each is a running sum rather than a matrix product
  // per pixel. Samples are bilinear, on pixel centres; outside the frame is black.
  const out = new Uint8ClampedArray(destWidth * destHeight * 4);
  for (let dy = 0; dy < destHeight; dy++) {
    const py = dy + 0.5;
    let nx = h0 * 0.5 + h1 * py + h2;
    let ny = h3 * 0.5 + h4 * py + h5;
    let nw = h6 * 0.5 + h7 * py + h8;
    let di = dy * destWidth * 4;
    for (let dx = 0; dx < destWidth; dx++, nx += h0, ny += h3, nw += h6, di += 4) {
      const x = nx / nw;
      const y = ny / nw;
      if (!(x >= 0 && y >= 0 && x < sourceWidth && y < sourceHeight)) {
        out[di + 3] = 255;
        continue;
      }
      const x0 = Math.floor(x - 0.5);
      const y0 = Math.floor(y - 0.5);
      const fx = x - 0.5 - x0;
      const fy = y - 0.5 - y0;
      const cx0 = x0 < 0 ? 0 : x0;
      const cx1 = x0 + 1 > sourceWidth - 1 ? sourceWidth - 1 : x0 + 1;
      const cy0 = y0 < 0 ? 0 : y0;
      const cy1 = y0 + 1 > sourceHeight - 1 ? sourceHeight - 1 : y0 + 1;
      const i00 = (cy0 * sourceWidth + cx0) * 4;
      const i10 = (cy0 * sourceWidth + cx1) * 4;
      const i01 = (cy1 * sourceWidth + cx0) * 4;
      const i11 = (cy1 * sourceWidth + cx1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bottom = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out[di + c] = top * (1 - fy) + bottom * fy;
      }
    }
  }

  return { width: destWidth, height: destHeight, data: out };
}

export type Quad = [Point, Point, Point, Point];

/**
 * The four corners as TL, TR, BR, BL, or null if they do not make a quad.
 *
 * The markers always come out that way - each L says which corner it is, and
 * the detector rejects any four that cross over - so a quad that is already
 * convex and clockwise is returned as it is. Dragged handles promise nothing:
 * two can be swapped, or the whole box turned inside out, and warped as given
 * that folds or mirrors the page. Those are put back in order round their
 * centre, starting from the corner nearest the top left. Four points that are
 * not a convex quad in any order - three in a line, or one inside the other
 * three - have no pane to rectify.
 */
export function normalizeQuad(points: Point[]): Quad | null {
  if (points.length !== 4 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  if (isClockwiseConvex(points)) return [points[0], points[1], points[2], points[3]];

  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  // Image y points down, so increasing angle goes clockwise on screen.
  const around = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  for (let i = 1; i < 4; i++) {
    if (around[i].x + around[i].y < around[first].x + around[first].y) first = i;
  }
  const ordered = [0, 1, 2, 3].map((i) => around[(first + i) % 4]) as Quad;
  return isClockwiseConvex(ordered) ? ordered : null;
}

/** Smallest area, as a share of the quad's bounding box, that still counts as a quad rather than a line. */
const MIN_QUAD_FILL = 0.05;

function isClockwiseConvex(quad: Point[]): boolean {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    // Each turn clockwise on screen, which with y down is a positive cross product.
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return false;
    area += a.x * b.y - b.x * a.y;
  }
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  return area / 2 >= box * MIN_QUAD_FILL && box > 0;
}

/**
 * What the camera is assumed to be, for recovering the pane's true proportions.
 *
 * Four corners in a photograph do not by themselves say how wide the pane is
 * against how tall: the same quad is a square seen from one angle or a long
 * rectangle seen from another. Knowing the camera settles it. Assumed here:
 * square pixels, no skew, the optical centre at the middle of the frame the
 * camera produced, and a focal length of FOCAL_FRACTION of that frame's long
 * side. How much the answer leans on the focal length grows with how steeply
 * the pane is seen. At the angles the real captures were taken from, anything
 * from 800 to 1500 px on a 1920 frame moves it by about 1%; a pane seen 20-30
 * degrees off square, with the lens 30% off, can be a few percent out - still
 * about half the error of averaging the edges (tests/rectify.geometry.test.ts).
 */
export interface Intrinsics {
  focalPx: number;
  /** Optical centre, in the pixel coordinates of the image the corners are in. */
  cx: number;
  cy: number;
}

/** A phone's main camera, as a share of the long side of the frame it hands over. */
export const FOCAL_FRACTION = 0.6;

/**
 * The assumed camera for a frame of this size. `crop` is where the image the
 * corners are measured in sat inside that frame, for a fixture cut down from
 * the full capture; the optical centre stays where it was in the full frame.
 */
export function assumedIntrinsics(frameWidth: number, frameHeight: number, crop: Point = { x: 0, y: 0 }): Intrinsics {
  return {
    focalPx: FOCAL_FRACTION * Math.max(frameWidth, frameHeight),
    cx: frameWidth / 2 - crop.x,
    cy: frameHeight / 2 - crop.y,
  };
}

export type AspectMethod = "known" | "projective" | "edge-average";

export interface PaneAspect {
  /** Width over height of the pane itself, not of its photograph. */
  aspect: number;
  method: AspectMethod;
  /**
   * A known aspect that was given and set aside, because the camera disagreed
   * with it by more than KNOWN_ASPECT_TOLERANCE. Whatever it came with - the
   * pane's size, its grid - describes some other pane, most likely the same
   * window before it was resized, and is not to be used either.
   */
  setAside?: number;
}

/**
 * How far the camera's own answer may be from a given aspect before the given
 * one is taken to be out of date. The camera's answer was within 0.9% on every
 * real capture (tests/markers.photos.test.ts), and a window resized by hand
 * changes its proportions by more than this almost however it is dragged.
 */
export const KNOWN_ASPECT_TOLERANCE = 0.02;

/**
 * Width over height of the pane the four corners (TL, TR, BR, BL) surround.
 *
 * The pane's own size, when the screen side has said what it is, is the
 * answer and nothing is estimated - unless the camera can check it and says
 * otherwise, in which case it is out of date and set aside (see
 * KNOWN_ASPECT_TOLERANCE). Otherwise the corners are taken back
 * through the assumed camera (see Intrinsics): the homography from a unit
 * square to the corners is K [r1 r2 t] diag(w, h, 1), so the lengths of its
 * first two columns, with K taken off, are in the ratio w to h.
 *
 * Averaging the photographed edges instead is what this replaces. A side
 * further from the camera photographs shorter, and the average of a near and a
 * far side is not the length of either - on the real captures it was off by up
 * to 4%, where the projective answer was within 1%. It is still the fallback,
 * for when the camera is unknown or the projective answer is not a number:
 * when the pane is square to the camera the two agree anyway.
 */
export function estimatePaneAspect(
  corners: Point[],
  options: { intrinsics?: Intrinsics; knownAspect?: number } = {}
): PaneAspect {
  const known = options.knownAspect;
  const given = known !== undefined && Number.isFinite(known) && known > 0;

  const average = estimateAspectRatio(corners);
  let measured: PaneAspect = { aspect: average, method: "edge-average" };
  if (options.intrinsics) {
    const projective = projectiveAspect(corners, options.intrinsics);
    // Far from the average means the geometry was degenerate, not that the
    // photograph was: no real shot of a pane doubles or halves its edges.
    if (Number.isFinite(projective) && projective > average / 2 && projective < average * 2) {
      measured = { aspect: projective, method: "projective" };
    }
  }

  if (!given) return measured;
  // Only the camera's answer is good enough to overrule a given one: the edge
  // average is off by more than the tolerance on ordinary shots.
  if (measured.method === "projective" && Math.abs(known / measured.aspect - 1) > KNOWN_ASPECT_TOLERANCE) {
    return { ...measured, setAside: known };
  }
  return { aspect: known, method: "known" };
}

function projectiveAspect(corners: Point[], k: Intrinsics): number {
  const unit: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  let h: Homography;
  try {
    h = computeHomography(unit, corners);
  } catch {
    return NaN;
  }
  const unproject = (x: number, y: number, z: number) =>
    Math.hypot((x - k.cx * z) / k.focalPx, (y - k.cy * z) / k.focalPx, z);
  return unproject(h[0], h[3], h[6]) / unproject(h[1], h[4], h[7]);
}

/** Measures the average width/height of a quad (ordered TL, TR, BR, BL) to pick a destination aspect ratio. */
export function estimateAspectRatio(corners: Point[]): number {
  const [tl, tr, br, bl] = corners;
  const topW = distance(tl, tr);
  const bottomW = distance(bl, br);
  const leftH = distance(tl, bl);
  const rightH = distance(tr, br);
  const avgW = (topW + bottomW) / 2;
  const avgH = (leftH + rightH) / 2;
  return avgW / avgH;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How big to make the rectified image.
 *
 * `fixed` is a set width, the height following from the aspect - what every
 * capture used to get, at 1600. `source` follows the photograph instead: the
 * longer of each pair of opposite edges, so no row or column of the pane is
 * squeezed into fewer pixels than the camera gave it, times `oversample`. With
 * the pane's own size known (overlay.py prints it), `source` is that size
 * times `oversample` instead, so every capture of a pane lays its character
 * cells out at the same size whatever distance it was taken from.
 */
export type OutputSizing =
  | { kind: "fixed"; width: number }
  | { kind: "source"; oversample: number; paneSize?: { width: number; height: number } };

/** Bounds on the rectified image, so a still from a 12 MP camera cannot run a phone out of memory. */
export const MAX_OUTPUT_WIDTH = 2400;
export const MAX_OUTPUT_PIXELS = 4_000_000;

export interface OutputSize {
  width: number;
  height: number;
  /** Whether the bounds above cut it down from what was asked for. */
  clamped: boolean;
}

/**
 * Camera pixels per screen pixel, over the pane: how finely the shot sampled
 * what was on screen. Below 1 the camera took fewer samples than the screen
 * has pixels, and a glyph's strokes - a pixel or two wide - fall between them.
 * The square root of the ratio of areas, so a pane seen at an angle counts its
 * near and far halves together.
 */
export function cameraPxPerScreenPx(corners: Point[], pane: { width: number; height: number }): number {
  let twice = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.sqrt(Math.abs(twice) / 2 / (pane.width * pane.height));
}

export function chooseOutputSize(corners: Point[], aspect: number, sizing: OutputSizing): OutputSize {
  let width: number;
  if (sizing.kind === "fixed") {
    width = sizing.width;
  } else if (sizing.paneSize) {
    width = sizing.paneSize.width * sizing.oversample;
  } else {
    const [tl, tr, br, bl] = corners;
    const across = Math.max(distance(tl, tr), distance(bl, br));
    const down = Math.max(distance(tl, bl), distance(tr, br));
    width = Math.max(across, down * aspect) * sizing.oversample;
  }

  const limit = Math.min(MAX_OUTPUT_WIDTH, Math.sqrt(MAX_OUTPUT_PIXELS * aspect));
  const clamped = width > limit;
  if (clamped) width = limit;

  const w = Math.max(1, Math.round(width));
  return { width: w, height: Math.max(1, Math.round(w / aspect)), clamped };
}

export interface Rectified {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  corners: Quad;
  aspect: PaneAspect;
  size: OutputSize;
}

/**
 * The pane, flattened: corners put in order, proportions recovered, size
 * chosen, then one warp from the photograph. The app and the metrics harness
 * both go through here, so what is measured is what the app reads.
 */
export function rectifyFrame(
  image: ImageData,
  corners: Point[],
  options: { sizing: OutputSizing; intrinsics?: Intrinsics; knownAspect?: number }
): Rectified | null {
  const quad = normalizeQuad(corners);
  if (!quad) return null;

  const aspect = estimatePaneAspect(quad, { intrinsics: options.intrinsics, knownAspect: options.knownAspect });
  // A pane size that came with an aspect the camera set aside is the wrong
  // pane's size too; the photograph decides instead.
  const sizing: OutputSizing =
    aspect.setAside !== undefined && options.sizing.kind === "source"
      ? { kind: "source", oversample: options.sizing.oversample }
      : options.sizing;
  const size = chooseOutputSize(quad, aspect.aspect, sizing);
  const warped = warpImageData(image, image.width, image.height, quad, size.width, size.height);
  return { ...warped, corners: quad, aspect, size };
}
