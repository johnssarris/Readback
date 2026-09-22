import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeCapture } from "./analyze";
import { drawDebugOverlay } from "../capture/debugOverlay";
import { buildRows, rowsToText } from "../model/lineIndex";
import { loadFixtures } from "../../tests/harness/cases";
import { loadAtlas, runFixture } from "../../tests/harness/run";
import { cloneImageData } from "../../tests/harness/image";
import { RasterContext } from "../../tests/harness/raster";

/**
 * The debug grid must never reach what recognition reads.
 *
 * It used to be drawn onto the rectified capture itself and read back from it,
 * so the lines around every cell went into the match as ink. These tests pin
 * down both halves of the fix: the analysis leaves its input alone, and the
 * overlay - drawn anywhere at all - changes nothing it reads.
 */

const fixture = loadFixtures().find((f) => f.name === "code-19px")!;
const atlas = loadAtlas();

function hash(image: ImageData): string {
  return createHash("sha256").update(image.data).digest("hex");
}

describe("analyzeCapture and the debug overlay", () => {
  it.skipIf(!atlas)("reads the same text however often it runs, and never writes to its input", { timeout: 60_000 }, () => {
    const { rectified } = runFixture(fixture, "flat");
    const before = hash(rectified);

    const first = analyzeCapture(rectified, "window", atlas);
    expect(hash(rectified)).toBe(before);

    // The overlay goes on a layer of its own. Whatever it draws there, a second
    // reading of the capture is the same as the first.
    const layer = cloneImageData(rectified);
    drawDebugOverlay(new RasterContext(layer), rectified, first.margins!, first.pitch);
    expect(hash(layer)).not.toBe(before);

    const second = analyzeCapture(rectified, "window", atlas);
    expect(hash(rectified)).toBe(before);
    expect(rowsToText(second.rows!)).toBe(rowsToText(first.rows!));
  });

  it.skipIf(!atlas)("would read differently if the overlay were drawn on the capture", { timeout: 60_000 }, () => {
    // The test above is only worth something if the overlay can change a
    // reading at all. Burned into the pixels, as it used to be, it does.
    const { rectified } = runFixture(fixture, "flat");
    const clean = analyzeCapture(rectified, "window", atlas);

    const burned = cloneImageData(rectified);
    drawDebugOverlay(new RasterContext(burned), burned, clean.margins!, clean.pitch);
    // The old app measured the grid on a clean copy and read the text from the
    // drawn-on canvas, so that is what this reproduces.
    const contaminated = buildRows(burned, clean.margins!, clean.pitch!, atlas!);

    expect(rowsToText(contaminated)).not.toBe(rowsToText(clean.rows!));
  });
});
