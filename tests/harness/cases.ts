import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Point } from "../../src/pipeline/rectify";
import { loadPng } from "./image";

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
  /** Window corners in image pixels (TL, TR, BR, BL). Required for a photo; a flat capture is its own frame. */
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
    rowYCenters: number[];
    fontPx: number;
  };
}

export interface Fixture {
  name: string;
  meta: FixtureMeta;
  image: ImageData;
  /** Ground-truth lines, trailing newline stripped. */
  lines: string[];
}

/** Every fixture in tests/fixtures: a .png plus a .json sidecar naming its ground-truth text. */
export function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURE_DIR)) return [];

  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const name = file.replace(/\.json$/, "");
      const meta: FixtureMeta = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
      const png = join(FIXTURE_DIR, `${name}.png`);
      if (!existsSync(png)) {
        throw new Error(`Fixture ${name}.json has no ${name}.png beside it`);
      }
      const text = readFileSync(join(FIXTURE_DIR, meta.text), "utf8").replace(/\n$/, "");
      return { name, meta, image: loadPng(png), lines: text.split("\n") };
    });
}
