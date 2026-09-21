import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARM, FILL_RATIO, MARGIN, THICK } from "./markerGeometry";

/**
 * The overlay is a standalone script that runs on another machine, so it keeps
 * its own constants rather than importing anything. This is what stops the two
 * from drifting: if someone retunes the markers in one place and not the other,
 * the detector would be looking for a shape nobody draws, and the only symptom
 * would be corners quietly landing somewhere else.
 */
const overlay = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "overlay.py"),
  "utf8"
);

function constantIn(script: string, name: string): number {
  const match = script.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, "m"));
  if (!match) throw new Error(`overlay.py has no ${name} constant`);
  return Number(match[1]);
}

describe("marker geometry", () => {
  it("matches the overlay that draws the markers", () => {
    expect(constantIn(overlay, "ARM")).toBe(ARM);
    expect(constantIn(overlay, "THICK")).toBe(THICK);
    expect(constantIn(overlay, "MARGIN")).toBe(MARGIN);
  });

  it("expects an L that is about a third ink", () => {
    // Two 40x8 arms sharing an 8x8 corner, in a 40x40 box.
    expect(FILL_RATIO).toBeCloseTo(0.36, 2);
  });
});
