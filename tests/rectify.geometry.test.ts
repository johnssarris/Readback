import { describe, expect, it } from "vitest";
import {
  assumedIntrinsics,
  estimateAspectRatio,
  estimatePaneAspect,
  FOCAL_FRACTION,
  rectifyFrame,
} from "../src/pipeline/rectify";
import { luminance } from "../src/pipeline/imageUtils";
import { gridPane, photographPane, type Pose } from "./harness/camera";

/**
 * Rectification against geometry that is known exactly.
 *
 * A grid pane of known size is photographed by a pinhole camera from a range
 * of angles and positions (see harness/camera.ts), then flattened again from
 * its four corners. What comes back is measured, not looked at: how far the
 * recovered proportions are from the pane's own, and how far each grid line
 * lies from where it should be - which is also how straight it is, since each
 * line is measured at three places along its length.
 */

const PANE_W = 1200;
const PANE_H = 690;
const STEP_X = 24;
const STEP_Y = 48;
const THICK = 6;
const TRUE_ASPECT = PANE_W / PANE_H;

const pane = gridPane(PANE_W, PANE_H, STEP_X, STEP_Y, THICK);

/** Recovered width-to-height, as a share of the truth, when the camera is what is assumed. */
const ASPECT_TOLERANCE = 0.01;

/** The same, at a hand-held angle, when the real focal length is 30% off the assumed one. */
const ASPECT_TOLERANCE_WRONG_FOCAL = 0.02;

/** Largest distance, in rectified pixels, of any grid line from where it belongs. */
const LINE_TOLERANCE_PX = 0.5;

const POSES: Record<string, Pose> = {
  "square on": {},
  "rolled 5°": { roll: 5 },
  "rolled 15°": { roll: 15 },
  "rolled 30°": { roll: 30 },
  "off to one side": { shiftX: 0.25 },
  "off the top": { shiftY: 0.3 },
  "off in a corner": { shiftX: -0.2, shiftY: 0.25 },
  "from the side (yaw 30°)": { yaw: 30 },
  "from below (pitch 25°)": { pitch: 25 },
  "strong keystone (yaw 30°, pitch 20°)": { yaw: 30, pitch: 20 },
  "everything at once": { yaw: -25, pitch: 15, roll: 10, shiftX: 0.1, shiftY: -0.1 },
};

/** Other frames the camera might hand over, each shot at the hardest pose. */
const FRAMES: Array<[number, number]> = [
  [1920, 1080],
  [720, 1280],
  [3024, 4032],
];

function focalFor(width: number, height: number): number {
  return FOCAL_FRACTION * Math.max(width, height);
}

describe("rectifying a photographed pane of known size", () => {
  for (const [name, pose] of Object.entries(POSES)) {
    it(`recovers the pane ${name}, in a 1080 x 1920 frame`, { timeout: 30_000 }, () => {
      check(1080, 1920, pose);
    });
  }

  for (const [width, height] of FRAMES) {
    it(`recovers the pane with strong keystone in a ${width} x ${height} frame`, { timeout: 60_000 }, () => {
      check(width, height, POSES["strong keystone (yaw 30°, pitch 20°)"]);
    });
  }

  // The focal length is assumed, not known, so the recovered proportions lean
  // on it more the steeper the view. At the angles the real captures were
  // taken from - their top and bottom edges differ by up to 15% - a lens 30%
  // longer or wider than assumed costs about a percent. Seen steeply, it costs
  // a few, which is still well short of what averaging the edges costs.
  for (const factor of [1.3, 1 / 1.3]) {
    const lens = factor > 1 ? "longer" : "wider";

    it(`stays within ${ASPECT_TOLERANCE_WRONG_FOCAL * 100}% at a hand-held angle when the lens is 30% ${lens} than assumed`, { timeout: 30_000 }, () => {
      for (const pose of [{ yaw: 10, pitch: 8 }, { yaw: 15, pitch: 10 }, { yaw: -12, pitch: -10, roll: 4 }]) {
        const shot = photographPane(pane, 1080, 1920, focalFor(1080, 1920) * factor, pose);
        const { aspect, method } = estimatePaneAspect(shot.corners, { intrinsics: assumedIntrinsics(1080, 1920) });
        expect(method).toBe("projective");
        expect(Math.abs(aspect / TRUE_ASPECT - 1)).toBeLessThan(ASPECT_TOLERANCE_WRONG_FOCAL);
      }
    });

    it(`still beats averaging the edges from a steep angle when the lens is 30% ${lens} than assumed`, { timeout: 30_000 }, () => {
      for (const pose of [{ yaw: 20 }, { pitch: 15 }, { yaw: 30, pitch: 20 }]) {
        const shot = photographPane(pane, 1080, 1920, focalFor(1080, 1920) * factor, pose);
        const projective = estimatePaneAspect(shot.corners, { intrinsics: assumedIntrinsics(1080, 1920) }).aspect;
        const average = estimateAspectRatio(shot.corners);
        expect(Math.abs(projective / TRUE_ASPECT - 1)).toBeLessThan(Math.abs(average / TRUE_ASPECT - 1));
      }
    });
  }

  it("does better than averaging the edges once the pane is seen at an angle", () => {
    const shot = photographPane(pane, 1080, 1920, focalFor(1080, 1920), POSES["strong keystone (yaw 30°, pitch 20°)"], 0.55);
    const projective = estimatePaneAspect(shot.corners, { intrinsics: assumedIntrinsics(1080, 1920) }).aspect;
    const average = estimateAspectRatio(shot.corners);
    expect(Math.abs(projective / TRUE_ASPECT - 1)).toBeLessThan(Math.abs(average / TRUE_ASPECT - 1) / 2);
  });

  it("takes a known pane size as it is", () => {
    const shot = photographPane(pane, 1080, 1920, focalFor(1080, 1920), POSES["everything at once"]);
    const known = estimatePaneAspect(shot.corners, { knownAspect: 985 / 563, intrinsics: assumedIntrinsics(1080, 1920) });
    expect(known).toEqual({ aspect: 985 / 563, method: "known" });
  });
});

function check(width: number, height: number, pose: Pose): void {
  const shot = photographPane(pane, width, height, focalFor(width, height), pose);
  for (const corner of shot.corners) {
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.y).toBeGreaterThan(0);
    expect(corner.x).toBeLessThan(width);
    expect(corner.y).toBeLessThan(height);
  }

  const rectified = rectifyFrame(shot.image, shot.corners, {
    sizing: { kind: "fixed", width: PANE_W },
    intrinsics: assumedIntrinsics(width, height),
  })!;

  expect(rectified.aspect.method).toBe("projective");
  expect(Math.abs(rectified.aspect.aspect / TRUE_ASPECT - 1)).toBeLessThan(ASPECT_TOLERANCE);

  // Lines are placed by the proportions actually recovered, so this measures
  // the flattening alone; the proportions were checked just above.
  expect(worstLineError(rectified)).toBeLessThan(LINE_TOLERANCE_PX);
}

/**
 * The farthest any grid line lies from where it should, in rectified pixels.
 *
 * Each vertical line is found at three heights, and each horizontal line at
 * three places across, by the centre of mass of its ink in a window around
 * where it belongs, and always between the lines running the other way so
 * they do not pull on the measurement.
 */
function worstLineError(image: { width: number; height: number; data: Uint8ClampedArray }): number {
  const sx = image.width / PANE_W;
  const sy = image.height / PANE_H;
  const ink = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    return Math.max(0, 250 - luminance(image.data[i], image.data[i + 1], image.data[i + 2]));
  };

  let worst = 0;

  // Vertical lines, at three heights midway between horizontal lines.
  for (const bandRow of [2, 7, 12]) {
    const y0 = Math.round((bandRow * STEP_Y + STEP_Y / 2 - STEP_Y / 6) * sy);
    const y1 = Math.round((bandRow * STEP_Y + STEP_Y / 2 + STEP_Y / 6) * sy);
    for (let k = 1; k * STEP_X + THICK < PANE_W; k++) {
      const expected = (k * STEP_X + THICK / 2) * sx;
      const measured = centroid(expected, (STEP_X / 3) * sx, (x) => {
        let sum = 0;
        for (let y = y0; y < y1; y++) sum += ink(x, y);
        return sum;
      });
      worst = Math.max(worst, Math.abs(measured - expected));
    }
  }

  // Horizontal lines, at three places across midway between vertical lines.
  for (const bandCol of [5, 25, 45]) {
    const x0 = Math.round((bandCol * STEP_X + STEP_X / 2 - STEP_X / 6) * sx);
    const x1 = Math.round((bandCol * STEP_X + STEP_X / 2 + STEP_X / 6) * sx);
    for (let k = 1; k * STEP_Y + THICK < PANE_H; k++) {
      const expected = (k * STEP_Y + THICK / 2) * sy;
      const measured = centroid(expected, (STEP_Y / 4) * sy, (y) => {
        let sum = 0;
        for (let x = x0; x < x1; x++) sum += ink(x, y);
        return sum;
      });
      worst = Math.max(worst, Math.abs(measured - expected));
    }
  }

  return worst;
}

/** Centre of mass of `weight` over whole pixels within `radius` of `around`, in pixel-centre coordinates. */
function centroid(around: number, radius: number, weight: (i: number) => number): number {
  let total = 0;
  let moment = 0;
  for (let i = Math.floor(around - radius); i <= Math.ceil(around + radius); i++) {
    const w = weight(i);
    total += w;
    moment += w * (i + 0.5);
  }
  return total > 0 ? moment / total : NaN;
}
