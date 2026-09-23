import { describe, expect, it } from "vitest";
import type { CaptureMeasures } from "./harness/capture";
import { loadFixtures } from "./harness/cases";
import { loadAtlas, runFixture, type Mode } from "./harness/run";

/**
 * The measurement run: every fixture through the whole pipeline, flat and
 * photographed, with the numbers printed as a table.
 *
 * This is a report, not a gate - the assertions only catch a pipeline that
 * stopped running at all. Read the table for what a change actually moved.
 */

const fixtures = loadFixtures();
const MODES: Mode[] = ["flat", "camera"];

/** Recognition is a normalized cross-correlation per glyph per cell; a fixture takes seconds, not milliseconds. */
const TIMEOUT_MS = 120_000;

function fmt(value: number | null, digits = 1, suffix = ""): string {
  if (value === null || Number.isNaN(value)) return "-";
  return value.toFixed(digits) + suffix;
}

/** Camera px per screen px, blur and the boundaries' bow, all in screen pixels; see measureCapture. */
function capture(measures: CaptureMeasures | null): string {
  if (!measures) return "capture n/a";
  const bow = (v: number | null) => (v === null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`);
  return (
    `dens ${measures.density.toFixed(2)} blur ${fmt(measures.blurPx, 1)} ` +
    `bow ${bow(measures.bowPx.top)}/${bow(measures.bowPx.bottom)}`
  );
}

describe("pipeline metrics", () => {
  if (fixtures.length === 0) {
    it.skip("no fixtures in tests/fixtures", () => {});
    return;
  }

  const rows: string[] = [];

  for (const fixture of fixtures) {
    for (const mode of MODES) {
      // A photo is already a photograph; running it through the camera
      // simulation twice would measure nothing real.
      if (fixture.meta.kind === "photo" && mode === "camera") continue;

      it(`${fixture.name} [${mode}]`, () => {
        const { metrics, margins, pitch, unreadable, warp, grid, notes } = runFixture(fixture, mode);

        // Nothing downstream ran, so there are no numbers to print - only the
        // reason, which is the whole result for that row.
        if (unreadable) {
          rows.push(`${`${fixture.name} [${mode}]`.padEnd(26)} ${unreadable}`);
          return;
        }

        rows.push(
          [
            `${fixture.name} [${mode}]`.padEnd(26),
            `body ${fmt(metrics.bodyTopErrorPx, 0)}/${fmt(metrics.bodyBottomErrorPx, 0)}px`.padEnd(20),
            `gutter ${fmt(metrics.gutterEdgeErrorPx, 0)}px`.padEnd(15),
            `cell ${fmt(metrics.cellWidthErrorPct, 1, "%")}x${fmt(metrics.cellHeightErrorPct, 1, "%")}`.padEnd(20),
            `rows ${metrics.rowsDetected}/${metrics.rowsExpected}`.padEnd(12),
            `rowoff ${fmt(metrics.rowOffsetCells, 2)}`.padEnd(13),
            `ink ${fmt(metrics.inkAccuracy * 100, 1, "%")}`.padEnd(12),
            `indent ${fmt(metrics.indentAccuracy * 100, 1, "%")}`.padEnd(15),
            `cer ${metrics.cer === null ? "n/a" : fmt(metrics.cer * 100, 2, "%")}`.padEnd(13),
            `num ${metrics.numberAccuracy === null ? "n/a" : fmt(metrics.numberAccuracy * 100, 1, "%")}`.padEnd(12),
            `marker ${metrics.markerErrorPx === null ? "n/a" : fmt(metrics.markerErrorPx, 2, "px")}`.padEnd(15),
            `wander ${fmt(metrics.columnWanderCells, 2)}`.padEnd(12),
            `grid ${grid ?? "-"}`.padEnd(15),
            capture(metrics.capture).padEnd(38),
            warp ? `out ${warp.width}x${warp.height} ${warp.aspect.toFixed(3)} ${warp.method} ${warp.ms.toFixed(0)}ms` : "",
          ].join(" ")
        );
        // Why the screen profile was not used, when it was not: a row whose
        // grid was estimated in spite of a profile is worth knowing about.
        for (const note of notes) rows.push(`${"".padEnd(26)} ${note}`);

        // Sanity only: the run produced a grid at all.
        expect(margins.gutterRightEdgeX).toBeGreaterThan(0);
        expect(Number.isFinite(pitch.widthPx)).toBe(true);
      }, TIMEOUT_MS);
    }
  }

  it("report", () => {
    const atlas = loadAtlas();
    const kinds = new Set(fixtures.map((f) => f.meta.kind));
    console.log(
      [
        "",
        "pipeline metrics".toUpperCase(),
        ...rows,
        "",
        atlas ? "atlas: loaded from public/atlas/" : "atlas: none built - cer not measured",
        kinds.has("render")
          ? "note: 'render' fixtures are Chromium stand-ins - geometry numbers only, not valid for atlas comparison"
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
