import { describe, expect, it } from "vitest";
import { analyzeCapture, prepareCapture, type ScreenFacts } from "./analyze";
import { inspectMarkers } from "./markers";
import { gridFromProfile } from "./profileGrid";
import { loadFixtures } from "../../tests/harness/cases";
import { makeImageData } from "../../tests/harness/image";

/**
 * The grid from the screen's own numbers, and every way of not using them.
 *
 * markers-900 is a rendered pane whose grid is known exactly - it is what the
 * renderer drew - so the profile overlay.py would print for it is known too:
 * 866 x 599, cell 11.133 x 23, text at 36.
 */

const fixture = loadFixtures().find((f) => f.name === "markers-900")!;
const truth = fixture.meta.truth!;
const rect = truth.paneRect!;
const pane = { width: rect.right - rect.left, height: rect.bottom - rect.top };
const grid = { advance: truth.cellWidthPx, lineHeight: truth.cellHeightPx, textLeft: truth.textAreaLeftX - rect.left };

function prepare(facts: ScreenFacts | null) {
  const corners = inspectMarkers(fixture.image).quad!.corners;
  const prepared = prepareCapture(fixture.image, corners, { facts })!;
  const { rectified } = prepared;
  return { ...prepared, image: makeImageData(rectified.width, rectified.height, rectified.data) };
}

describe("gridFromProfile", () => {
  it("lays the grid out where the editor drew it", { timeout: 30_000 }, () => {
    const { image } = prepare({ pane, grid });
    const scale = image.width / pane.width;
    const laid = gridFromProfile(image, grid, pane);

    expect(laid.check.agrees).toBe(true);
    expect(laid.check.evidence).toBe(true);
    expect(laid.pitch.widthPx).toBeCloseTo(grid.advance * scale, 6);
    expect(laid.pitch.heightPx).toBeCloseTo(grid.lineHeight * scale, 1);
    // The columns start where the text does, give or take the small shift the
    // photograph is allowed.
    expect(Math.abs(laid.pitch.columnOriginX - grid.textLeft * scale)).toBeLessThan(0.1 * laid.pitch.widthPx);
    // Twenty-six rows fit the pane; the document fills twenty-three, and the
    // rest are trimmed as blank.
    expect(laid.pitch.rowYCenters).toHaveLength(truth.rowCount);
    laid.pitch.rowYCenters.forEach((y, i) => {
      expect(Math.abs(y - (truth.rowYCenters[i] - rect.top) * scale)).toBeLessThan(0.5);
    });
  });

  // A point size up or down is about 7% on the cell's width: what a profile
  // printed before the font changed would say.
  it("is disagreed with by text a font size away from it", { timeout: 30_000 }, () => {
    const { image } = prepare({ pane, grid });
    for (const factor of [0.93, 1.07]) {
      const { check } = gridFromProfile(image, { ...grid, advance: grid.advance * factor }, pane);
      expect(check.evidence).toBe(true);
      expect(check.agrees).toBe(false);
      expect(Math.abs(check.bestRatio * factor - 1)).toBeLessThan(0.01);
    }
  });

  it("stands when the page has nothing on it to disagree with", () => {
    const blank = makeImageData(pane.width * 2, pane.height * 2, new Uint8ClampedArray(pane.width * pane.height * 16).fill(255));
    const { check } = gridFromProfile(blank, grid, pane);
    expect(check.evidence).toBe(false);
    expect(check.agrees).toBe(true);
  });
});

describe("falling back when the profile cannot be used", () => {
  it("uses the profile when it holds", { timeout: 60_000 }, () => {
    const { image, known, notes } = prepare({ pane, grid });
    expect(notes).toEqual([]);
    const analysis = analyzeCapture(image, "pane", null, known);
    expect(analysis.gridSource).toBe("profile");
  });

  it("estimates the grid when the text disagrees with the profile", { timeout: 60_000 }, () => {
    const { image, known } = prepare({ pane, grid: { ...grid, advance: grid.advance * 1.07 } });
    const analysis = analyzeCapture(image, "pane", null, known);
    expect(analysis.gridSource).toBe("estimated");
    expect(analysis.summary.join("\n")).toMatch(/screen profile set aside: the text lines up/);
    expect(analysis.pitch!.widthPx / image.width).toBeCloseTo(grid.advance / pane.width, 3);
  });

  it("estimates the grid when there is no profile, or only the pane's size", { timeout: 60_000 }, () => {
    for (const facts of [null, { pane, grid: null }]) {
      const { image, known } = prepare(facts);
      expect(known).toBeNull();
      expect(analyzeCapture(image, "pane", null, known).gridSource).toBe("estimated");
    }
  });

  it("does not use the profile on corners placed by hand", { timeout: 60_000 }, () => {
    const { image, known } = prepare({ pane, grid });
    const analysis = analyzeCapture(image, "window", null, known);
    expect(analysis.gridSource).toBe("estimated");
    expect(analysis.summary.join("\n")).toMatch(/placed by hand/);
  });
});
