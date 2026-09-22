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
  const inverse = invertHomography(forward);

  const out = new Uint8ClampedArray(destWidth * destHeight * 4);
  for (let dy = 0; dy < destHeight; dy++) {
    for (let dx = 0; dx < destWidth; dx++) {
      const srcPoint = applyHomography(inverse, { x: dx + 0.5, y: dy + 0.5 });
      const sample = bilinearSample(srcData, sourceWidth, sourceHeight, srcPoint.x, srcPoint.y);
      const di = (dy * destWidth + dx) * 4;
      out[di] = sample[0];
      out[di + 1] = sample[1];
      out[di + 2] = sample[2];
      out[di + 3] = sample[3];
    }
  }

  return { width: destWidth, height: destHeight, data: out };
}

function bilinearSample(
  data: ImageData,
  width: number,
  height: number,
  x: number,
  y: number
): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return [0, 0, 0, 255];
  }

  const x0 = Math.floor(x - 0.5);
  const y0 = Math.floor(y - 0.5);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - 0.5 - x0;
  const fy = y - 0.5 - y0;

  const cx0 = clamp(x0, 0, width - 1);
  const cx1 = clamp(x1, 0, width - 1);
  const cy0 = clamp(y0, 0, height - 1);
  const cy1 = clamp(y1, 0, height - 1);

  const p00 = pixelAt(data, width, cx0, cy0);
  const p10 = pixelAt(data, width, cx1, cy0);
  const p01 = pixelAt(data, width, cx0, cy1);
  const p11 = pixelAt(data, width, cx1, cy1);

  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = p00[c] * (1 - fx) + p10[c] * fx;
    const bottom = p01[c] * (1 - fx) + p11[c] * fx;
    result[c] = top * (1 - fy) + bottom * fy;
  }
  return result;
}

function pixelAt(data: ImageData, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [data.data[i], data.data[i + 1], data.data[i + 2], data.data[i + 3]];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
