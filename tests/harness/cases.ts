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
  /**
   * What the app recorded about the capture, when the fixture came out of its
   * save button: the frame size, what the camera track was doing, and the
   * detector's own account of the frame. Nothing here reads it - it is for
   * whoever is looking into why this particular capture went wrong.
   */
  diagnostics?: unknown;
  /**
   * The frame the camera produced, and where this image was cut from it. The
   * optical centre is assumed to be the middle of that frame, so a fixture
   * cropped down from a capture has to say where the crop was.
   */
  frame?: { width: number; height: number; cropX: number; cropY: number };
  /**
   * The pane's size on screen, in pixels, as overlay.py printed it. With the
   * corners it says how many screen pixels the camera spread over how many of
   * its own, which is what the capture measurements are in.
   */
  paneSize?: { width: number; height: number };
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

/**
 * Every fixture in tests/fixtures: an image plus a .json sidecar naming its
 * ground-truth text. The marker captures in markers/ join them once their
 * sidecars name the text they show; until then they are the marker detector's
 * alone.
 */
export function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURE_DIR)) return [];

  const markers = join(FIXTURE_DIR, "markers");
  const withText = existsSync(markers)
    ? sidecars("markers").filter((file) => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")).text)
    : [];
  return [...sidecars(""), ...withText].map(loadFixture);
}

/** The .json files in a directory under tests/fixtures, as paths relative to it. */
function sidecars(dir: string): string[] {
  return readdirSync(join(FIXTURE_DIR, dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => (dir ? `${dir}/${f}` : f));
}

function loadFixture(file: string): Fixture {
  const name = file.replace(/\.json$/, "");
  const meta: FixtureMeta = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
  // Written by hand as [x, y] pairs, as tests/fixtures/README.md shows them.
  if (meta.corners) meta.corners = meta.corners.map(toPoint) as FixtureMeta["corners"];
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
}

function toPoint(p: Point | [number, number]): Point {
  return Array.isArray(p) ? { x: p[0], y: p[1] } : p;
}
