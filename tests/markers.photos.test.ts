import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_DIR } from "./harness/cases";
import { loadImage } from "./harness/image";
import { inspectMarkers } from "../src/pipeline/markers";
import { assumedIntrinsics, estimateAspectRatio, estimatePaneAspect, normalizeQuad } from "../src/pipeline/rectify";

/**
 * The corner markers, found in real photographs of a real screen.
 *
 * Unlike the metrics run this is a gate: every photograph here has four
 * markers in it, and each was found by eye, so a detector that misses one or
 * puts a corner somewhere else has got worse. The captures in markers/ are
 * the ones that first showed it failing, kept so it cannot quietly fail on
 * them again.
 */

const MARKER_DIR = join(FIXTURE_DIR, "markers");

/** Pixels a corner may be from where it was seen to be. */
const TOLERANCE_PX = 3;

/**
 * The whole-pipeline photographs in the directory above, which carry no
 * corners of their own: their sidecars would hand them to the harness as a
 * fallback for when detection fails, which is exactly what this must not
 * paper over.
 */
const PIPELINE_PHOTOS: Record<string, Array<[number, number]>> = {
  "photo-far.jpg": [
    [340.5, 880.4],
    [1548.7, 851.7],
    [1537, 1562.4],
    [362.6, 1545],
  ],
  "photo-mid.jpg": [
    [335, 868],
    [1571.7, 848.9],
    [1539.4, 1510.9],
    [392.6, 1563.3],
  ],
  "photo-near.jpg": [
    [148.6, 653.4],
    [1723.3, 728.6],
    [1657, 1584.4],
    [163.4, 1565],
  ],
};

/** How far the recovered width-to-height ratio may be from the pane's own. */
const ASPECT_TOLERANCE = 0.015;

interface Frame {
  width: number;
  height: number;
  cropX: number;
  cropY: number;
}

interface Case {
  name: string;
  path: string;
  corners: Array<[number, number]>;
  frame: Frame;
  paneSize: { width: number; height: number };
}

const PHOTO_FRAME: Frame = { width: 1932, height: 2576, cropX: 0, cropY: 0 };

const cases: Case[] = [
  ...Object.entries(PIPELINE_PHOTOS).map(([name, corners]) => ({
    name,
    path: join(FIXTURE_DIR, name),
    corners,
    frame: PHOTO_FRAME,
    // Every sidecar says what overlay.py printed for the pane it shows.
    paneSize: (JSON.parse(readFileSync(join(FIXTURE_DIR, name.replace(/\.jpg$/, ".json")), "utf8")) as Case).paneSize,
  })),
  ...readdirSync(MARKER_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.json$/, ".jpg");
      const { corners, frame, paneSize } = JSON.parse(readFileSync(join(MARKER_DIR, f), "utf8")) as Case;
      return { name, path: join(MARKER_DIR, name), corners, frame, paneSize };
    }),
];

describe("markers in photographs", () => {
  for (const { name, path, corners } of cases) {
    it(`finds all four in ${name}`, { timeout: 30_000 }, () => {
      const report = inspectMarkers(loadImage(path));

      expect(report.outcome).toBe("found");
      // Not just found by some pair of levels: found by the first one tried.
      // The ladder is there for shots no single threshold reads, and a clean
      // photograph that already needs its outer levels is one step from
      // needing more than there are.
      expect(report.levels[0].outcome).toBe("found");
      report.quad!.corners.forEach((corner, i) => {
        const [x, y] = corners[i];
        expect(Math.hypot(corner.x - x, corner.y - y)).toBeLessThan(TOLERANCE_PX);
      });
      // What the detector hands over is already in order, and the check that
      // guards dragged corners must leave it exactly as it is.
      expect(normalizeQuad(report.quad!.corners)).toEqual(report.quad!.corners);
    });
  }
});

/**
 * The pane's proportions, recovered from where its corners are.
 *
 * Every photograph here is of the same 985 x 563 pane, from a different angle,
 * so every one should give back the same width-to-height ratio. Averaging the
 * photographed edges gave anything from 1.67 to 1.80 across them; taking the
 * corners back through the camera gives the pane's own 1.75 to within a
 * percent or so, which is what this holds it to.
 */
describe("the pane's proportions, from its corners", () => {
  for (const { name, corners, frame, paneSize } of cases) {
    it(`recovers ${paneSize.width} x ${paneSize.height} in ${name}`, () => {
      const points = corners.map(([x, y]) => ({ x, y }));
      const truth = paneSize.width / paneSize.height;
      const intrinsics = assumedIntrinsics(frame.width, frame.height, { x: frame.cropX, y: frame.cropY });
      const { aspect, method } = estimatePaneAspect(points, { intrinsics });

      expect(method).toBe("projective");
      expect(Math.abs(aspect / truth - 1)).toBeLessThan(ASPECT_TOLERANCE);
    });
  }

  it("is closer to the truth overall than averaging the edges", () => {
    const error = (estimate: (points: { x: number; y: number }[], c: Case) => number) =>
      cases.reduce((sum, c) => {
        const points = c.corners.map(([x, y]) => ({ x, y }));
        return sum + Math.abs(estimate(points, c) / (c.paneSize.width / c.paneSize.height) - 1);
      }, 0) / cases.length;

    const projective = error(
      (points, c) =>
        estimatePaneAspect(points, {
          intrinsics: assumedIntrinsics(c.frame.width, c.frame.height, { x: c.frame.cropX, y: c.frame.cropY }),
        }).aspect
    );
    const average = error((points) => estimateAspectRatio(points));
    expect(projective).toBeLessThan(average / 2);
  });
});
