import { describe, expect, it } from "vitest";
import { buildAtlasFromImageData, type AtlasManifest } from "../pipeline/match";
import type { MarginBounds } from "../pipeline/margins";
import type { CellPitch } from "../pipeline/calibrate";
import { buildRows, rowsToText, type LineRow } from "./lineIndex";

const CELL = 4;

type Pattern = Float32Array;

function quadrant(which: "tl" | "tr" | "bl" | "br"): Pattern {
  const data = new Float32Array(CELL * CELL).fill(255);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const inTop = y < CELL / 2;
      const inLeft = x < CELL / 2;
      const match =
        (which === "tl" && inTop && inLeft) ||
        (which === "tr" && inTop && !inLeft) ||
        (which === "bl" && !inTop && inLeft) ||
        (which === "br" && !inTop && !inLeft);
      if (match) data[y * CELL + x] = 0;
    }
  }
  return data;
}

function stripe(direction: "horizontal" | "vertical"): Pattern {
  const data = new Float32Array(CELL * CELL).fill(255);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const dark = direction === "horizontal" ? y < CELL / 2 : x < CELL / 2;
      if (dark) data[y * CELL + x] = 0;
    }
  }
  return data;
}

const PATTERNS: Record<string, Pattern> = {
  "1": quadrant("tl"),
  "2": quadrant("tr"),
  A: quadrant("bl"),
  B: quadrant("br"),
  C: stripe("horizontal"),
  D: stripe("vertical"),
};

function buildAtlasImage(): { image: ImageData; manifest: AtlasManifest } {
  const chars = Object.keys(PATTERNS);
  const width = CELL * chars.length;
  const data = new Uint8ClampedArray(width * CELL * 4);
  const sprites: AtlasManifest["sprites"] = {};

  chars.forEach((char, index) => {
    const offsetX = index * CELL;
    const pattern = PATTERNS[char];
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const gray = pattern[y * CELL + x];
        const i = (y * width + offsetX + x) * 4;
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        data[i + 3] = 255;
      }
    }
    sprites[char] = { x: offsetX, y: 0, w: CELL, h: CELL };
  });

  return {
    image: { width, height: CELL, data, colorSpace: "srgb" } as ImageData,
    manifest: {
      cellWidth: CELL,
      cellHeight: CELL,
      // These stand-in glyphs fill their cell, so their "baseline" is its bottom.
      baselineFraction: 1,
      canvasWidth: width,
      canvasHeight: CELL,
      fontSize: CELL,
      sprites,
    },
  };
}

/** Builds a 2-row, 2-column synthetic screenful: gutter digits "1"/"2", body text "AB"/"CD". */
function buildSceneImage(): ImageData {
  const width = 12; // gutter [0,4) + body [4,12)
  const height = 8; // two 4px-tall rows
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255); // white background everywhere (alpha channel gets overwritten below per-pixel too)
  for (let i = 3; i < data.length; i += 4) data[i] = 255; // alpha

  const place = (pattern: Pattern, offsetX: number, offsetY: number) => {
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const gray = pattern[y * CELL + x];
        const i = ((offsetY + y) * width + offsetX + x) * 4;
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        data[i + 3] = 255;
      }
    }
  };

  place(PATTERNS["1"], 0, 0);
  place(PATTERNS.A, 4, 0);
  place(PATTERNS.B, 8, 0);

  place(PATTERNS["2"], 0, 4);
  place(PATTERNS.C, 4, 4);
  place(PATTERNS.D, 8, 4);

  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

describe("buildRows + rowsToText", () => {
  it("reads real line numbers from the gutter and reconstructs body text", () => {
    const { image: atlasImage, manifest } = buildAtlasImage();
    const atlas = buildAtlasFromImageData(atlasImage, manifest);
    const scene = buildSceneImage();

    const margins: MarginBounds = {
      bodyTopY: 0,
      bodyBottomY: 8,
      gutterLeftX: 0,
      gutterRightEdgeX: 4,
      textAreaLeftX: 4,
      textAreaRightX: 12,
    };
    const pitch: CellPitch = {
      widthPx: CELL,
      heightPx: CELL,
      columnOriginX: 4,
      rowYCenters: [2, 6],
      rowBaselines: [4, 8], // cell bottom: these test glyphs fill their box
    };

    const rows = buildRows(scene, margins, pitch, atlas);

    expect(rows).toHaveLength(2);
    expect(rows[0].lineNumber).toBe(1);
    expect(rows[0].isWrappedContinuation).toBe(false);
    expect(rows[1].lineNumber).toBe(2);

    expect(rowsToText(rows)).toBe("AB\nCD");
  });
});

describe("rowsToText", () => {
  const COLUMNS = 16;

  const row = (text: string, isWrappedContinuation: boolean): LineRow => ({
    lineNumber: isWrappedContinuation ? NaN : 1,
    lineNumberConfidence: isWrappedContinuation ? 0 : 1,
    cells: [...text.padEnd(COLUMNS, " ")].map((char) => ({
      char,
      confidence: 1,
      candidates: [],
      flagged: false,
      corrected: false,
      rect: { x: 0, y: 0, w: 1, h: 1 },
    })),
    yRangePx: { top: 0, bottom: 1 },
    isWrappedContinuation,
  });

  it("puts a wrapped continuation back on the end of the line it belongs to", () => {
    // The row above ended before its last column, so the wrap fell on a space.
    const rows = [row("one long", false), row("line", true), row("next", false)];
    expect(rowsToText(rows)).toBe("one long line\nnext");
  });

  it("joins a mid-word break without inventing a space", () => {
    // The row above used every column, so nothing was broken at.
    const rows = [row("supercalifragilis", false), row("tic", true)];
    expect(rowsToText(rows)).toBe("supercalifragilistic");
  });

  it("starts a line when a continuation has nothing above it", () => {
    // The top row of a screenful can be a continuation of a line that scrolled
    // off; there is nothing to join it to, so it stands as its own line.
    expect(rowsToText([row("tail", true), row("next", false)])).toBe("tail\nnext");
  });
});
