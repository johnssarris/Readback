import type { Point } from "../../src/pipeline/rectify";
import { makeImageData } from "./image";

/**
 * A pinhole camera photographing a flat pane, for testing rectification
 * against geometry that is known exactly.
 *
 * degrade.ts's photograph() tilts a screenshot by moving its corners, which is
 * a fine stand-in for exercising the pipeline but is not what a lens does: no
 * camera produces exactly that quad. Recovering a pane's proportions from its
 * corners only works for a real perspective view, so this builds one - a pane
 * on the plane z = 0, a camera at a chosen angle and distance looking at it,
 * and every pixel of the frame traced back along its ray to the pane.
 *
 * It shares no code with the rectifier it is used to test.
 */
export interface Pose {
  /** Turn about the vertical axis, degrees: looking at the pane from its side. */
  yaw?: number;
  /** Turn about the horizontal axis, degrees: looking up or down at it. */
  pitch?: number;
  /** Turn about the optical axis, degrees: the phone held crooked. */
  roll?: number;
  /** Camera moved sideways, as a share of the pane's width, so the pane sits off-centre. */
  shiftX?: number;
  /** Camera moved up or down, as a share of the pane's height. */
  shiftY?: number;
}

export interface Shot {
  image: ImageData;
  /** Where the pane's corners landed in the frame, TL, TR, BR, BL. */
  corners: [Point, Point, Point, Point];
}

type Vec = [number, number, number];

/**
 * Photographs `pane` with a camera of focal length `focalPx`, the optical
 * centre at the middle of a `frameWidth` x `frameHeight` frame. The pane is
 * `fill` of the frame across (or of its height, if that is tighter) when seen
 * square on, before the pose moves the camera.
 */
export function photographPane(
  pane: ImageData,
  frameWidth: number,
  frameHeight: number,
  focalPx: number,
  pose: Pose = {},
  fill = 0.55
): Shot {
  const W = pane.width;
  const H = pane.height;
  const cx = frameWidth / 2;
  const cy = frameHeight / 2;

  const across = fill * Math.min(frameWidth, (frameHeight * W) / H);
  const distance = (focalPx * W) / across;

  const rad = Math.PI / 180;
  const rotation = mul(mul(rotY((pose.yaw ?? 0) * rad), rotX((pose.pitch ?? 0) * rad)), rotZ((pose.roll ?? 0) * rad));
  const shift: Vec = [(pose.shiftX ?? 0) * W, (pose.shiftY ?? 0) * H, 0];
  // Camera to world: orbit the pane's centre at `distance`, then slide sideways
  // in the camera's own frame.
  const centre = add(apply(rotation, [0, 0, -distance]), apply(rotation, shift));

  const project = (a: number, b: number): Point => {
    const world: Vec = [a - W / 2, b - H / 2, 0];
    const cam = applyT(rotation, sub(world, centre));
    return { x: (focalPx * cam[0]) / cam[2] + cx, y: (focalPx * cam[1]) / cam[2] + cy };
  };
  const corners: [Point, Point, Point, Point] = [project(0, 0), project(W, 0), project(W, H), project(0, H)];

  // Each pixel traced back to the pane, 4 x 4 samples a pixel: a pane seen at
  // half size puts a line across a fraction of a pixel, and one sample would
  // snap it to whichever pixel it happened to hit.
  const out = makeImageData(frameWidth, frameHeight);
  const offsets = [0.125, 0.375, 0.625, 0.875];
  const samples = offsets.length * offsets.length;
  for (let v = 0; v < frameHeight; v++) {
    for (let u = 0; u < frameWidth; u++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const oy of offsets) {
        for (const ox of offsets) {
          const ray = apply(rotation, [(u + ox - cx) / focalPx, (v + oy - cy) / focalPx, 1]);
          const s = -centre[2] / ray[2];
          const a = centre[0] + s * ray[0] + W / 2;
          const bb = centre[1] + s * ray[1] + H / 2;
          const [pr, pg, pb] = s > 0 ? sample(pane, a, bb) : BACKGROUND;
          r += pr;
          g += pg;
          b += pb;
        }
      }
      const i = (v * frameWidth + u) * 4;
      out.data[i] = r / samples;
      out.data[i + 1] = g / samples;
      out.data[i + 2] = b / samples;
      out.data[i + 3] = 255;
    }
  }
  return { image: out, corners };
}

/** What is behind the pane: a dark desk. */
const BACKGROUND: [number, number, number] = [38, 40, 44];

function sample(image: ImageData, x: number, y: number): [number, number, number] {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return BACKGROUND;
  const i = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

/**
 * A pane to photograph: white, with dark lines `thickness` px wide at every
 * `stepX` across and `stepY` down, starting at 0. A line's centre is at
 * k * step + thickness / 2.
 */
export function gridPane(width: number, height: number, stepX: number, stepY: number, thickness = 2): ImageData {
  const image = makeImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const line = x % stepX < thickness || y % stepY < thickness;
      const i = (y * width + x) * 4;
      const v = line ? 20 : 250;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  }
  return image;
}

function rotX(t: number): number[] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotY(t: number): number[] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function rotZ(t: number): number[] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function mul(a: number[], b: number[]): number[] {
  const m = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) m[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    }
  }
  return m;
}

function apply(m: number[], v: Vec): Vec {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** The transpose applied, which for a rotation is its inverse. */
function applyT(m: number[], v: Vec): Vec {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

function add(a: Vec, b: Vec): Vec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
