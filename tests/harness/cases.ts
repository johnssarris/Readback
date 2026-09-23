import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GridProfile } from "../../src/pipeline/profileGrid";
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
  /**
   * The lines of `text` the screen showed, first and last, counting from 1,
   * when it was not scrolled to the top: what the overlay's label says. Without
   * it the file is taken from its first line.
   */
  lines?: [number, number];
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
  /**
   * Windows' display scaling on the pane's monitor, as a multiple (1.5 for
   * 150%), which the markers are drawn at. From the overlay's label; 1 when
   * not given.
   */
  scaling?: number;
  /**
   * The grid as overlay.py printed it beside the pane's size, in screen pixels
   * from the pane's corner. Only what was actually printed on the machine: a
   * guessed one would make the metrics measure the guess.
   */
  profile?: GridProfile;
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
  /** The line number beside each displayed row, null on a wrapped continuation; null when not known. */
  rowNumbers: (number | null)[] | null;
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
  const lines = visibleLines(readFileSync(join(FIXTURE_DIR, meta.text), "utf8"), meta);
  if (meta.truth) {
    const rows = meta.truth.displayRows ?? lines;
    return { name, meta, image: loadImage(image), lines, rows, rowNumbers: meta.truth.rowNumbers ?? null };
  }
  // A photo's rows are its lines as the editor wrapped them, which the
  // profile says enough to repeat: how many columns the pane holds.
  const wrapped =
    meta.profile && meta.paneSize
      ? wrapRows(lines, Math.floor((meta.paneSize.width - meta.profile.textLeft) / meta.profile.advance), meta.lines?.[0] ?? 1)
      : null;
  return { name, meta, image: loadImage(image), lines, rows: wrapped?.rows ?? lines, rowNumbers: wrapped?.rowNumbers ?? null };
}

/**
 * Lines laid out in rows the way the editor wraps them at word boundaries: a
 * line longer than the pane breaks after the last space that fits, or at the
 * last column when no space does, and carries on at the start of the next row
 * with no line number beside it.
 */
export function wrapRows(lines: string[], columns: number, firstLine: number): { rows: string[]; rowNumbers: (number | null)[] } {
  const rows: string[] = [];
  const rowNumbers: (number | null)[] = [];
  lines.forEach((line, i) => {
    let rest = line;
    let number: number | null = firstLine + i;
    while (rest.length > columns) {
      let cut = columns;
      while (cut > 0 && !(rest[cut - 1] === " " && rest[cut] !== " ")) cut--;
      if (cut === 0) cut = columns;
      rows.push(rest.slice(0, cut));
      rowNumbers.push(number);
      rest = rest.slice(cut);
      number = null;
    }
    rows.push(rest);
    rowNumbers.push(number);
  });
  return { rows, rowNumbers };
}

/**
 * The lines of a fixture's text the window actually showed.
 *
 * Only what is on screen can be recognized, so a source file longer than the
 * screenful is cut to what was showing rather than charged as errors: from
 * the sidecar's `lines` when it gives them, and otherwise from the top, as far
 * as the recorded truth says the window reached.
 */
export function visibleLines(text: string, meta: Pick<FixtureMeta, "lines" | "truth">): string[] {
  let all = text.replace(/\n$/, "").split("\n");
  if (meta.lines) {
    const [first, last] = meta.lines;
    if (!(Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last >= first)) {
      throw new Error(`lines must be [first, last] counting from 1, not ${JSON.stringify(meta.lines)}`);
    }
    all = all.slice(first - 1, last);
  }
  return all.slice(0, meta.truth?.lineCount ?? meta.truth?.rowCount ?? all.length);
}

function toPoint(p: Point | [number, number]): Point {
  return Array.isArray(p) ? { x: p[0], y: p[1] } : p;
}
