import { applyHomography, computeHomography, warpImageData, type Point } from "../../src/pipeline/rectify";
import { makeImageData } from "./image";

/**
 * Turns a flat screenshot into something shaped like a phone photo of the same
 * screen: off-axis, slightly soft, unevenly lit, and noisy. A screenshot fed
 * straight to the pipeline measures the segmentation in isolation; this measures
 * it against the degradations a real capture actually carries.
 *
 * Deterministic: same input, same seed, same pixels, so a metric delta between
 * two runs is always a code change and never the weather.
 */

export interface CameraView {
  image: ImageData;
  /** Where the screenshot's corners ended up, in camera pixels (TL, TR, BR, BL). */
  corners: [Point, Point, Point, Point];
}

export interface CameraOptions {
  seed?: number;
  /** Camera pixels per screen pixel. A phone framing a window fills more sensor than screen. */
  scale?: number;
  /** Perspective tilt, as a fraction of the frame. 0 is straight on. */
  tilt?: number;
  /** Gaussian blur sigma, in camera pixels. */
  blurSigma?: number;
  /** Gaussian noise sigma, in luminance levels. */
  noiseSigma?: number;
  /** Illumination falloff across the frame: 1 is flat, 0.8 means the dark corner keeps 80%. */
  vignette?: number;
}

const DEFAULTS: Required<CameraOptions> = {
  seed: 20260921,
  scale: 1.35,
  tilt: 0.035,
  blurSigma: 0.9,
  noiseSigma: 2.5,
  vignette: 0.84,
};

/** Mulberry32: small, seeded, and good enough for noise. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number): number {
  // Box-Muller, one of the pair.
  const u = Math.max(next(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

export function photograph(screenshot: ImageData, options: CameraOptions = {}): CameraView {
  const opts = { ...DEFAULTS, ...options };
  const next = rng(opts.seed);

  const camWidth = Math.round(screenshot.width * opts.scale);
  const camHeight = Math.round(screenshot.height * opts.scale);

  // The window sits inside the frame with a margin, tilted: the top edge a
  // little narrower than the bottom, as when shooting a screen from below.
  const mx = camWidth * 0.06;
  const my = camHeight * 0.06;
  const tiltX = camWidth * opts.tilt;
  const tiltY = camHeight * opts.tilt * 0.4;
  const corners: [Point, Point, Point, Point] = [
    { x: mx + tiltX, y: my },
    { x: camWidth - mx - tiltX * 0.3, y: my + tiltY },
    { x: camWidth - mx, y: camHeight - my },
    { x: mx, y: camHeight - my - tiltY * 0.6 },
  ];

  // warpImageData maps a quad onto a rectangle; the camera does the opposite, so
  // warp the frame's corners onto the screenshot and read it back through that.
  const frameCorners: Point[] = [
    { x: 0, y: 0 },
    { x: camWidth, y: 0 },
    { x: camWidth, y: camHeight },
    { x: 0, y: camHeight },
  ];
  const projected = projectInto(screenshot, corners, frameCorners, camWidth, camHeight);

  illuminate(projected, opts.vignette);
  const blurred = opts.blurSigma > 0 ? blur(projected, opts.blurSigma) : projected;
  addNoise(blurred, opts.noiseSigma, next);

  return { image: blurred, corners };
}

/**
 * Places `source` inside a camera frame so that its own corners land on
 * `destCorners`, leaving everything outside as desk-coloured background.
 */
function projectInto(
  source: ImageData,
  destCorners: Point[],
  frameCorners: Point[],
  width: number,
  height: number
): ImageData {
  // Warping the frame's corners (as a quad in source space) onto the frame
  // rectangle is the inverse of placing the source quad in the frame, so first
  // map the frame corners back into source coordinates.
  const sourceCorners: Point[] = [
    { x: 0, y: 0 },
    { x: source.width, y: 0 },
    { x: source.width, y: source.height },
    { x: 0, y: source.height },
  ];
  const frameInSource = mapQuad(frameCorners, destCorners, sourceCorners);
  const warped = warpImageData(source, source.width, source.height, frameInSource, width, height);
  const out = makeImageData(width, height, warped.data);

  // warpImageData clamps out-of-bounds reads to the edge pixel, which would
  // smear the window across the whole frame. Paint everything outside the quad
  // as background instead.
  const inside = quadMask(destCorners, width, height);
  for (let i = 0; i < width * height; i++) {
    if (!inside[i]) {
      const d = i * 4;
      out.data[d] = 38;
      out.data[d + 1] = 40;
      out.data[d + 2] = 44;
      out.data[d + 3] = 255;
    }
  }
  return out;
}

/** Maps points from one quad's space into another's, via the homography between them. */
function mapQuad(points: Point[], from: Point[], to: Point[]): Point[] {
  const h = computeHomography(from, to);
  return points.map((p) => applyHomography(h, p));
}

/** Per-pixel inside/outside test for a convex quad, by consistent edge sign. */
function quadMask(corners: Point[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let inside = true;
      for (let i = 0; i < 4 && inside; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const cross = (b.x - a.x) * (y + 0.5 - a.y) - (b.y - a.y) * (x + 0.5 - a.x);
        if (cross < 0) inside = false;
      }
      mask[y * width + x] = inside ? 1 : 0;
    }
  }
  return mask;
}

/** A soft diagonal falloff, as from a light source off to one side. */
function illuminate(image: ImageData, floor: number): void {
  const { width, height, data } = image;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width) * 0.6 + (y / height) * 0.4;
      const gain = 1 - (1 - floor) * t;
      const i = (y * width + x) * 4;
      data[i] *= gain;
      data[i + 1] *= gain;
      data[i + 2] *= gain;
    }
  }
}

function blur(image: ImageData, sigma: number): ImageData {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const { width, height, data } = image;
  const pass = new Uint8ClampedArray(data.length);
  const out = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(width - 1, Math.max(0, x + k));
          acc += data[(y * width + sx) * 4 + c] * kernel[k + radius];
        }
        pass[(y * width + x) * 4 + c] = acc;
      }
      pass[(y * width + x) * 4 + 3] = 255;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sy = Math.min(height - 1, Math.max(0, y + k));
          acc += pass[(sy * width + x) * 4 + c] * kernel[k + radius];
        }
        out[(y * width + x) * 4 + c] = acc;
      }
      out[(y * width + x) * 4 + 3] = 255;
    }
  }
  return makeImageData(width, height, out);
}

function addNoise(image: ImageData, sigma: number, next: () => number): void {
  if (sigma <= 0) return;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const n = gaussian(next) * sigma;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
}
