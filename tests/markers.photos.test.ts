import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_DIR } from "./harness/cases";
import { loadImage } from "./harness/image";
import { inspectMarkers } from "../src/pipeline/markers";

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

const cases: Array<{ name: string; path: string; corners: Array<[number, number]> }> = [
  ...Object.entries(PIPELINE_PHOTOS).map(([name, corners]) => ({ name, path: join(FIXTURE_DIR, name), corners })),
  ...readdirSync(MARKER_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.json$/, ".jpg");
      const { corners } = JSON.parse(readFileSync(join(MARKER_DIR, f), "utf8")) as {
        corners: Array<[number, number]>;
      };
      return { name, path: join(MARKER_DIR, name), corners };
    }),
];

describe("markers in photographs", () => {
  for (const { name, path, corners } of cases) {
    it(`finds all four in ${name}`, { timeout: 30_000 }, () => {
      const report = inspectMarkers(loadImage(path));

      expect(report.outcome).toBe("found");
      report.quad!.corners.forEach((corner, i) => {
        const [x, y] = corners[i];
        expect(Math.hypot(corner.x - x, corner.y - y)).toBeLessThan(TOLERANCE_PX);
      });
    });
  }
});
