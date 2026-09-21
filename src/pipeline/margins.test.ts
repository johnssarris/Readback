import { describe, expect, it } from "vitest";
import { detectMargins } from "./margins";

const WIDTH = 200;
const HEIGHT = 150;
const TAB_BAR_HEIGHT = 10;
const STATUS_BAR_HEIGHT = 20;
const GUTTER_WIDTH = 30;
const LINE_PITCH = 10;

const CHROME = 60;
const GUTTER_GREY = 200;
const PAGE = 250;
const INK = 30;

interface WindowOptions {
  /**
   * Line numbers in the gutter and text in the text area, as a real window has.
   * "partial" leaves blank page below the text; "full" fills the body.
   */
  content?: "none" | "partial" | "full";
  /** Gutter background. Equal to PAGE is the flattened gutter the plain-view script used to produce. */
  gutter?: number;
}

/** Builds a synthetic rectified-window image: tab bar, editor body (gutter + text), status bar. */
function buildSyntheticWindow(options: WindowOptions = {}): ImageData {
  const { content = "none", gutter = GUTTER_GREY } = options;
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);

  const setPixel = (x: number, y: number, gray: number) => {
    const i = (y * WIDTH + x) * 4;
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
    data[i + 3] = 255;
  };

  const fill = (x0: number, y0: number, x1: number, y1: number, gray: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPixel(x, y, gray);
  };

  const bodyTop = TAB_BAR_HEIGHT;
  const bodyBottom = HEIGHT - STATUS_BAR_HEIGHT;

  fill(0, 0, WIDTH, HEIGHT, CHROME);
  fill(0, bodyTop, WIDTH, bodyBottom, PAGE);
  fill(0, bodyTop, GUTTER_WIDTH, bodyBottom, gutter);

  if (content !== "none") {
    // "partial" puts five lines at the top and leaves more blank page below them
    // than the text occupies, so a mean-based profile splits the body at the last
    // line of text and calls the blank remainder the tallest band. "full" fills
    // the body instead, so nothing but the gutter's own background separates the
    // line numbers from the text.
    const shapes = [
      { indent: 0, length: 14 },
      { indent: 2, length: 11 },
      { indent: 4, length: 9 },
      { indent: 2, length: 13 },
      { indent: 0, length: 6 },
    ];
    const rowCount = content === "full" ? Math.floor((bodyBottom - bodyTop - 2) / LINE_PITCH) : shapes.length;
    const lines = Array.from({ length: rowCount }, (_, i) => shapes[i % shapes.length]);
    const cell = 6;

    lines.forEach((line, i) => {
      const top = bodyTop + 2 + i * LINE_PITCH;
      const bottom = top + 6; // glyphs are shorter than the line box

      // Right-aligned line number: two digits from line 10 on, one before it.
      const digits = i + 1 >= 9 ? 2 : 1;
      fill(GUTTER_WIDTH - 2 - digits * cell, top, GUTTER_WIDTH - 2, bottom, INK);

      // Text, as alternating inked cells so the row is ink and gaps rather than a bar.
      for (let c = line.indent; c < line.indent + line.length; c++) {
        if (c % 3 === 2) continue;
        const x = GUTTER_WIDTH + c * cell;
        fill(x, top, Math.min(WIDTH, x + cell - 1), bottom, INK);
      }
    });
  }

  return { width: WIDTH, height: HEIGHT, data, colorSpace: "srgb" } as ImageData;
}

/** A pane on its own: gutter and text, no chrome anywhere, text stopping short of the bottom. */
function buildSyntheticPane(): ImageData {
  const width = 200;
  const height = 120;
  const data = new Uint8ClampedArray(width * height * 4);

  const fill = (x0: number, y0: number, x1: number, y1: number, gray: number) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        data[i + 3] = 255;
      }
    }
  };

  fill(0, 0, width, height, PAGE);
  fill(0, 0, GUTTER_WIDTH, height, GUTTER_GREY);

  // Rectifying to the pane's corners catches a hair of what is just outside
  // them - the marker tile's edge, the chrome behind it - along the top and
  // bottom rows. Two pixels of it is enough to be a boundary.
  fill(0, 0, width, 2, CHROME);
  fill(0, height - 2, width, height, CHROME);

  for (let line = 0; line < 5; line++) {
    const top = 2 + line * LINE_PITCH;
    fill(GUTTER_WIDTH - 8, top, GUTTER_WIDTH - 2, top + 6, INK);
    for (let c = 0; c < 12; c++) {
      if (c % 3 === 2) continue;
      fill(GUTTER_WIDTH + c * 6, top, GUTTER_WIDTH + c * 6 + 5, top + 6, INK);
    }
  }

  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

describe("detectMargins", () => {
  it("locates the editor body between the tab bar and status bar", () => {
    const margins = detectMargins(buildSyntheticWindow());

    expect(margins.bodyTopY).toBeGreaterThanOrEqual(8);
    expect(margins.bodyTopY).toBeLessThanOrEqual(12);
    expect(margins.bodyBottomY).toBeGreaterThanOrEqual(128);
    expect(margins.bodyBottomY).toBeLessThanOrEqual(132);
  });

  it("locates the gutter/text-area boundary", () => {
    const margins = detectMargins(buildSyntheticWindow());

    expect(margins.gutterRightEdgeX).toBeGreaterThanOrEqual(28);
    expect(margins.gutterRightEdgeX).toBeLessThanOrEqual(33);
    expect(margins.textAreaLeftX).toBe(margins.gutterRightEdgeX);
  });

  it("falls back to full width when no scrollbar boundary is present", () => {
    const margins = detectMargins(buildSyntheticWindow());
    expect(margins.textAreaRightX).toBe(WIDTH);
  });

  it("keeps the body when the window holds text and blank page below it", () => {
    const margins = detectMargins(buildSyntheticWindow({ content: "partial" }));

    // The text ends around y=60; the body still runs to the status bar.
    expect(margins.bodyTopY).toBeGreaterThanOrEqual(8);
    expect(margins.bodyTopY).toBeLessThanOrEqual(12);
    expect(margins.bodyBottomY).toBeGreaterThanOrEqual(128);
    expect(margins.bodyBottomY).toBeLessThanOrEqual(132);
  });

  it("finds the gutter edge past the line numbers, not at their left edge", () => {
    // Text through the whole body, so the column scan sees the line numbers:
    // their ink is the first thing a mean-based profile calls a boundary.
    const margins = detectMargins(buildSyntheticWindow({ content: "full" }));

    // Two-digit numbers start at x=16. The boundary is the background step at
    // x=30, and ink inside the gutter must not be mistaken for it.
    expect(margins.gutterRightEdgeX).toBeGreaterThanOrEqual(28);
    expect(margins.gutterRightEdgeX).toBeLessThanOrEqual(32);
  });

  it("keeps the whole image as the body when the markers framed the pane", () => {
    // No chrome in the picture: the markers cut it away, so the first row of
    // text starts at the very top and the last ends at the very bottom.
    const image = buildSyntheticPane();

    const pane = detectMargins(image, "pane");
    expect(pane.bodyTopY).toBe(0);
    expect(pane.bodyBottomY).toBe(image.height);

    // The window path reads that hair as the chrome it was written to find,
    // and the body it settles on is inside the pane - which costs the first
    // row of text, the one hard against the top edge.
    const window = detectMargins(image, "window");
    expect(window.bodyTopY).toBeGreaterThan(0);
    expect(window.bodyBottomY).toBeLessThan(image.height);
  });

  it("cannot find a gutter edge when the gutter is painted the page colour", () => {
    // What plain_view.py produced before it left the line number margin grey:
    // with no step to find, the first boundary is whatever ink comes first.
    const margins = detectMargins(buildSyntheticWindow({ content: "full", gutter: PAGE }));

    expect(margins.gutterRightEdgeX).toBeLessThan(28);
  });
});
