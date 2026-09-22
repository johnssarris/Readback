import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Point } from "../../src/pipeline/rectify";
import { loadImage } from "./image";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * What the fixture's sidecar JSON can say. Everything but `kind` and `text` is
 * optional: a real screenshot or phone photo brings its source text and nothing
 * else, and every metric that needs more is skipped rather than guessed at.
 */
export interface FixtureMeta {
  /** render: Chromium stand-in, geometry only. screenshot: real Notepad++. photo: shot with a phone. */
  kind: "render" | "screenshot" | "photo";
  /** Ground-truth text file, relative to the fixtures directory. */
  text: string;
  note?: string;
  /**
   * Window corners in image pixels (TL, TR, BR, BL). Optional: with corner
   * markers in the shot they are found rather than given, and a flat capture
   * with no markers is its own frame.
   */
  corners?: [Point, Point, Point, Point];
  /** Known geometry, when the fixture was generated rather than captured. */
  truth?: {
    cellWidthPx: number;
    cellHeightPx: number;
    bodyTopY: number;
    bodyBottomY: number;
    gutterRightEdgeX: number;
    textAreaLeftX: number;
    rowCount: number;
    /** The pane the corner markers surround, when the fixture has them. */
    paneRect?: { left: number; top: number; right: number; bottom: number } | null;
    /** Logical lines fully visible in the window; with wrap on, fewer than rowCount. */
    lineCount?: number;
    /** The rows as the editor laid them out, for metrics that score the grid rather than the text. */
    displayRows?: string[];
    /** The line number on each display row; null where the row is a wrapped continuation. */
    rowNumbers?: (number | null)[];
    rowYCenters: number[];
    fontPx: number;
    wrapped?: boolean;
  };
}

export interface Fixture {
  name: string;
  meta: FixtureMeta;
  image: ImageData;
  /** Ground-truth lines, trailing newline stripped. */
  lines: string[];
  /** Ground truth per displayed row. Same as `lines` unless the window wrapped them. */
  rows: string[];
}

/** The image formats a fixture can be stored in; see `loadImage`. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];

/** Every fixture in tests/fixtures: an image plus a .json sidecar naming its ground-truth text. */
export function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURE_DIR)) return [];

  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const name = file.replace(/\.json$/, "");
      const meta: FixtureMeta = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
      const image = IMAGE_EXTENSIONS.map((ext) => join(FIXTURE_DIR, name + ext)).find(existsSync);
      if (!image) {
        throw new Error(`Fixture ${name}.json has no ${name}${IMAGE_EXTENSIONS.join("/")} beside it`);
      }
      const text = readFileSync(join(FIXTURE_DIR, meta.text), "utf8").replace(/\n$/, "");

      // Only what the window actually shows can be recognized from it, so a
      // source file longer than the screenful is truncated to what is on screen
      // rather than charged as errors.
      const all = text.split("\n");
      const lines = all.slice(0, meta.truth?.lineCount ?? meta.truth?.rowCount ?? all.length);
      return { name, meta, image: loadImage(image), lines, rows: meta.truth?.displayRows ?? lines };
    });
}
