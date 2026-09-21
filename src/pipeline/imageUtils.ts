export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Percentile luminance of row `y`, restricted to [xStart, xEnd).
 *
 * A mean would answer "how much ink is in this row", which is a property of the
 * text. A high percentile answers "what colour is the page here", which is a
 * property of the window — and that is what a region boundary actually is.
 */
export function rowLuminance(
  data: ImageData,
  y: number,
  xStart = 0,
  xEnd = data.width,
  percentile = 0.5
): number {
  const histogram = new Array(256).fill(0);
  for (let x = xStart; x < xEnd; x++) {
    const i = (y * data.width + x) * 4;
    histogram[clampLevel(luminance(data.data[i], data.data[i + 1], data.data[i + 2]))]++;
  }
  return percentileOf(histogram, xEnd - xStart, percentile);
}

/** Percentile luminance of column `x`, restricted to [yStart, yEnd). */
export function colLuminance(
  data: ImageData,
  x: number,
  yStart = 0,
  yEnd = data.height,
  percentile = 0.5
): number {
  const histogram = new Array(256).fill(0);
  for (let y = yStart; y < yEnd; y++) {
    const i = (y * data.width + x) * 4;
    histogram[clampLevel(luminance(data.data[i], data.data[i + 1], data.data[i + 2]))]++;
  }
  return percentileOf(histogram, yEnd - yStart, percentile);
}

function clampLevel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** The luminance level at `percentile` of a 256-bin histogram holding `total` samples. */
function percentileOf(histogram: number[], total: number, percentile: number): number {
  if (total <= 0) return 255;
  const target = Math.max(1, Math.ceil(total * percentile));
  let seen = 0;
  for (let level = 0; level < 256; level++) {
    seen += histogram[level];
    if (seen >= target) return level;
  }
  return 255;
}

/** Returns the [start, end) index ranges of contiguous `true` runs in `mask`. */
export function findRuns(mask: boolean[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && runStart === -1) {
      runStart = i;
    } else if (!mask[i] && runStart !== -1) {
      runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    runs.push({ start: runStart, end: mask.length });
  }
  return runs;
}

/** Otsu's method: finds the luminance threshold that best separates `values` into two classes. */
export function otsuThreshold(values: number[]): number {
  const histogram = new Array(256).fill(0);
  for (const v of values) {
    histogram[Math.max(0, Math.min(255, Math.round(v)))]++;
  }

  const total = values.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * histogram[t];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;

    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];

    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;

    const betweenVariance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (betweenVariance > maxVariance) {
      maxVariance = betweenVariance;
      threshold = t;
    }
  }

  return threshold;
}

/** Bilinear sample of a single-channel grayscale buffer, clamping out-of-bounds reads to white. */
export function bilinearGraySample(gray: Float32Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 255;

  const x0 = Math.floor(x - 0.5);
  const y0 = Math.floor(y - 0.5);
  const fx = x - 0.5 - x0;
  const fy = y - 0.5 - y0;

  const cx0 = Math.max(0, Math.min(width - 1, x0));
  const cx1 = Math.max(0, Math.min(width - 1, x0 + 1));
  const cy0 = Math.max(0, Math.min(height - 1, y0));
  const cy1 = Math.max(0, Math.min(height - 1, y0 + 1));

  const p00 = gray[cy0 * width + cx0];
  const p10 = gray[cy0 * width + cx1];
  const p01 = gray[cy1 * width + cx0];
  const p11 = gray[cy1 * width + cx1];

  const top = p00 * (1 - fx) + p10 * fx;
  const bottom = p01 * (1 - fx) + p11 * fx;
  return top * (1 - fy) + bottom * fy;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Crops `rect` out of `image` and resamples it (grayscale, bilinear) to destWidth x destHeight. */
export function resampleToGray(image: ImageData, rect: Rect, destWidth: number, destHeight: number): Float32Array {
  const srcGray = new Float32Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const i = ((rect.y + y) * image.width + (rect.x + x)) * 4;
      srcGray[y * rect.w + x] = luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
  }

  const dest = new Float32Array(destWidth * destHeight);
  for (let dy = 0; dy < destHeight; dy++) {
    for (let dx = 0; dx < destWidth; dx++) {
      const sx = ((dx + 0.5) * rect.w) / destWidth;
      const sy = ((dy + 0.5) * rect.h) / destHeight;
      dest[dy * destWidth + dx] = bilinearGraySample(srcGray, rect.w, rect.h, sx, sy);
    }
  }
  return dest;
}

/**
 * Where ink stops and page begins, for a region of a capture.
 *
 * Read against the region's own brightness rather than a level fixed for the
 * whole image: light falls unevenly across a photographed screen, and a
 * threshold that fits the top of the window calls the bottom corner ink. The
 * page is read above any text on it, and ink sits far below the page it is
 * drawn on - far enough that neither sensor noise nor a darkening corner
 * reaches it.
 */
export function inkThreshold(values: number[]): number {
  return percentile(values, PAGE_PERCENTILE) * INK_FRACTION_OF_PAGE;
}

const PAGE_PERCENTILE = 0.9;
const INK_FRACTION_OF_PAGE = 0.55;

/** The value at `fraction` of the way up a set of samples. */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 255;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
