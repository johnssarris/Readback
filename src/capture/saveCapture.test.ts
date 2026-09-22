import { describe, expect, it } from "vitest";
import { sidecar, type CaptureRecord } from "./saveCapture";
import type { FixtureMeta } from "../../tests/harness/cases";

/**
 * A saved capture is only worth saving if it drops into tests/fixtures/ and is
 * measured there, so what these check is that it is that file - the same shape
 * the harness reads - and not merely valid JSON.
 */

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    frame: { width: 1932, height: 2576 } as HTMLCanvasElement,
    corners: {
      tl: { x: 148.6, y: 653.2 },
      tr: { x: 1723.4, y: 727.8 },
      br: { x: 1657.1, y: 1585.4 },
      bl: { x: 166.3, y: 1565.9 },
    },
    fromMarkers: true,
    report: {
      quad: null,
      outcome: "found",
      threshold: 54,
      blobs: 598,
      candidates: { tl: 46, tr: 21, br: 30, bl: 52 },
      quadsTried: 1,
      levels: [
        { threshold: 54, outcome: "found" },
        { threshold: 70, outcome: "found" },
      ],
      agreeing: 2,
      ms: 864,
    },
    track: { width: 1932, height: 2576, frameRate: 30 },
    ...overrides,
  };
}

describe("sidecar", () => {
  it("is a fixture sidecar the harness would accept", () => {
    const meta = JSON.parse(sidecar(record(), "readback-20260922-154530")) as FixtureMeta;

    expect(meta.kind).toBe("photo");
    expect(meta.text).toBeTypeOf("string");
    // Corners in image pixels, clockwise from the top left, rounded - the
    // sidecar is read by people as well as by the harness.
    expect(meta.corners).toEqual([
      [149, 653],
      [1723, 728],
      [1657, 1585],
      [166, 1566],
    ]);
  });

  it("records what the detector made of the frame", () => {
    const meta = JSON.parse(sidecar(record(), "x")) as FixtureMeta & { diagnostics: any };

    expect(meta.diagnostics.markers).toEqual({
      outcome: "found",
      threshold: 54,
      blobs: 598,
      candidates: { tl: 46, tr: 21, br: 30, bl: 52 },
      quadsTried: 1,
      levels: [
        { threshold: 54, outcome: "found" },
        { threshold: 70, outcome: "found" },
      ],
      agreeing: 2,
      ms: 864,
    });
    expect(meta.diagnostics.frame).toEqual({ width: 1932, height: 2576 });
    expect(meta.diagnostics.cornersFrom).toBe("markers");

    // What the camera granted, which is rarely what was asked for, and is the
    // first thing to check when a capture is too coarse to read.
    expect(meta.diagnostics.track).toEqual({ width: 1932, height: 2576, frameRate: 30 });
  });

  it("says when the corners were placed by hand", () => {
    const meta = JSON.parse(sidecar(record({ fromMarkers: false }), "x")) as { diagnostics: any };
    expect(meta.diagnostics.cornersFrom).toBe("hand");
  });

  // The capture measurements are in screen pixels, so a capture saved with
  // the pane's size is measured as soon as it is dropped in, unedited.
  it("carries the screen profile as far as it was given, and leaves out what was not", () => {
    const pane = { width: 985, height: 563 };
    const grid = { advance: 10.75, lineHeight: 23, textLeft: 42 };

    const whole = JSON.parse(sidecar(record({ screen: { pane, grid } }), "x")) as FixtureMeta;
    expect(whole.paneSize).toEqual(pane);
    expect(whole.profile).toEqual(grid);

    const sizeOnly = JSON.parse(sidecar(record({ screen: { pane, grid: null } }), "x")) as FixtureMeta;
    expect(sizeOnly.paneSize).toEqual(pane);
    expect(sizeOnly).not.toHaveProperty("profile");

    const none = JSON.parse(sidecar(record(), "x")) as FixtureMeta;
    expect(none).not.toHaveProperty("paneSize");
    expect(none).not.toHaveProperty("profile");
  });
});
