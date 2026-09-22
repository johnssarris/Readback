import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { calibrateCellPitch, type CellPitch } from "../../src/pipeline/calibrate";
import { detectMargins, type MarginBounds } from "../../src/pipeline/margins";
import { buildAtlasFromImageData, type AtlasManifest, type GlyphAtlas } from "../../src/pipeline/match";
import {
  applyHomography,
  computeHomography,
  estimateAspectRatio,
  warpImageData,
  type Point,
} from "../../src/pipeline/rectify";
import { inspectMarkers, type MarkerReport } from "../../src/pipeline/markers";
import { buildRows, rowsToText } from "../../src/model/lineIndex";
import { photograph, type CameraOptions } from "./degrade";
import type { Fixture } from "./cases";
import { makeImageData } from "./image";
import {
  characterErrorRate,
  inkAccuracy,
  indentAccuracy,
  inkMap,
  numberAccuracy,
  type Metrics,
} from "./metrics";

/** Mirrors CaptureController: every capture is rectified to this width. */
const DEST_WIDTH = 1600;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Mode = "flat" | "camera";

export interface RunResult {
  margins: MarginBounds;
  pitch: CellPitch;
  metrics: Metrics;
  text: string | null;
  /** The rectified image the pipeline actually worked on. */
  rectified: ImageData;
  /** Scale from fixture pixels to rectified pixels, for comparing against truth. */
  scale: { x: number; y: number };
  /** Why the run produced nothing, when it did; null when the pipeline ran. */
  unreadable: string | null;
}

/**
 * Runs a fixture through the same sequence CaptureController does - rectify,
 * detect margins, calibrate, recognize - and scores the result.
 *
 * `flat` feeds the screenshot in as-is (its corners are the image's), measuring
 * the segmentation on its own. `camera` photographs it first, measuring the
 * same code against perspective, blur, noise and uneven light.
 */
export function runFixture(fixture: Fixture, mode: Mode, camera?: CameraOptions): RunResult {
  const source = fixture.image;

  let image: ImageData;
  let corners: Point[];

  if (fixture.meta.kind === "photo") {
    image = source;
  } else if (mode === "camera") {
    image = photograph(source, camera).image;
  } else {
    image = source;
  }

  // Corner markers first, since they name the pane itself rather than the
  // window around it. The sidecar's own corners are next, and a flat capture
  // with neither is its own frame.
  const report = inspectMarkers(image);
  const markers = report.quad;
  if (markers) {
    corners = markers.corners;
  } else if (fixture.meta.corners) {
    corners = fixture.meta.corners;
  } else if (fixture.meta.kind === "photo") {
    // A photo with neither is not a broken fixture, it is the detector failing
    // on it, and that is a result to report rather than an error to throw:
    // nothing in the image says where the window is, so there is nothing left
    // to measure, and the table should say so on the row - including which
    // stage of the detector the markers were lost at.
    return unread(fixture, image, report);
  } else if (mode === "camera") {
    corners = photograph(source, camera).corners;
  } else {
    corners = [
      { x: 0, y: 0 },
      { x: source.width, y: 0 },
      { x: source.width, y: source.height },
      { x: 0, y: source.height },
    ];
  }

  const aspect = estimateAspectRatio(corners);
  const destHeight = Math.round(DEST_WIDTH / aspect);
  const warped = warpImageData(image, image.width, image.height, corners, DEST_WIDTH, destHeight);
  const rectified = makeImageData(warped.width, warped.height, warped.data);

  // Markers name the pane itself, so what was rectified has no chrome in it.
  const margins = detectMargins(rectified, markers ? "pane" : "window");
  const pitch = calibrateCellPitch(rectified, margins);

  // Truth is recorded in the drawn image's own coordinates. What was rectified
  // is the pane when markers named it, and the whole window otherwise, so the
  // mapping from one to the other differs.
  const pane = fixture.meta.truth?.paneRect;
  const region = pane
    ? { left: pane.left, top: pane.top, width: pane.right - pane.left, height: pane.bottom - pane.top }
    : { left: 0, top: 0, width: source.width, height: destHeight === 0 ? 1 : source.height };
  const view = {
    scale: { x: DEST_WIDTH / region.width, y: destHeight / region.height },
    origin: { x: region.left, y: region.top },
  };
  const metrics = score(fixture, rectified, margins, pitch, view);

  if (markers && pane) {
    const want: Point[] = [
      { x: pane.left, y: pane.top },
      { x: pane.right, y: pane.top },
      { x: pane.right, y: pane.bottom },
      { x: pane.left, y: pane.bottom },
    ];
    // In a photographed frame the pane's corners are wherever the camera put
    // them, so they are compared through the same mapping the camera applied.
    const placed = mode === "camera" && fixture.meta.kind !== "photo" ? mapThroughCamera(source, image, want) : want;
    metrics.markerErrorPx =
      markers.corners.reduce((sum, c, i) => sum + Math.hypot(c.x - placed[i].x, c.y - placed[i].y), 0) / 4;
  }

  let text: string | null = null;
  const atlas = loadAtlas();
  if (atlas && Number.isFinite(pitch.widthPx) && pitch.widthPx > 0 && pitch.rowYCenters.length > 0) {
    const rows = buildRows(rectified, margins, pitch, atlas);
    text = rowsToText(rows);
    metrics.cer = characterErrorRate(text, fixture.lines.join("\n"));

    const expected = fixture.meta.truth?.rowNumbers;
    if (expected) metrics.numberAccuracy = numberAccuracy(rows, expected);
  }

  return { margins, pitch, metrics, text, rectified, scale: view.scale, unreadable: null };
}

/**
 * The result for a fixture the pipeline could not start on, so the table has a
 * row for it saying why rather than the run stopping at the first one.
 */
function unread(fixture: Fixture, image: ImageData, report: MarkerReport): RunResult {
  return {
    margins: { bodyTopY: 0, bodyBottomY: 0, gutterRightEdgeX: 0, textAreaLeftX: 0, textAreaRightX: 0, gutterLeftX: 0 },
    pitch: { widthPx: NaN, heightPx: NaN, columnOriginX: NaN, rowYCenters: [], rowBaselines: [] },
    metrics: {
      bodyTopErrorPx: null,
      bodyBottomErrorPx: null,
      gutterEdgeErrorPx: null,
      cellWidthErrorPct: null,
      cellHeightErrorPct: null,
      rowsDetected: 0,
      rowsExpected: fixture.meta.truth?.rowCount ?? fixture.lines.length,
      rowOffsetCells: null,
      inkAccuracy: 0,
      indentAccuracy: 0,
      cer: null,
      numberAccuracy: null,
      markerErrorPx: null,
    },
    text: null,
    rectified: image,
    scale: { x: 1, y: 1 },
    unreadable:
      `${report.outcome} (ink<=${report.threshold}, ${report.blobs} blobs, ` +
      `${CORNER_ORDER.map((c) => `${c}:${report.candidates[c]}`).join(" ")}, ` +
      `${report.quadsTried} quads, ${report.ms}ms)`,
  };
}

const CORNER_ORDER = ["tl", "tr", "br", "bl"] as const;

function score(
  fixture: Fixture,
  rectified: ImageData,
  margins: MarginBounds,
  pitch: CellPitch,
  view: { scale: { x: number; y: number }; origin: { x: number; y: number } }
): Metrics {
  const truth = fixture.meta.truth;
  const { scale, origin } = view;
  const atX = (x: number) => (x - origin.x) * scale.x;
  const atY = (y: number) => (y - origin.y) * scale.y;

  const columns =
    Number.isFinite(pitch.widthPx) && pitch.widthPx > 0
      ? Math.floor((margins.textAreaRightX - pitch.columnOriginX) / pitch.widthPx)
      : 0;
  const map = columns > 0 ? inkMap(rectified, margins, pitch, columns) : [];

  let rowOffsetCells: number | null = null;
  if (truth && truth.rowYCenters.length > 0 && pitch.rowYCenters.length > 0 && pitch.heightPx > 0) {
    const n = Math.min(truth.rowYCenters.length, pitch.rowYCenters.length);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += Math.abs(pitch.rowYCenters[i] - atY(truth.rowYCenters[i]));
    }
    rowOffsetCells = sum / n / pitch.heightPx;
  }

  return {
    bodyTopErrorPx: truth ? margins.bodyTopY - atY(truth.bodyTopY) : null,
    bodyBottomErrorPx: truth ? margins.bodyBottomY - atY(truth.bodyBottomY) : null,
    gutterEdgeErrorPx: truth ? margins.gutterRightEdgeX - atX(truth.gutterRightEdgeX) : null,
    cellWidthErrorPct: truth ? pct(pitch.widthPx, truth.cellWidthPx * scale.x) : null,
    cellHeightErrorPct: truth ? pct(pitch.heightPx, truth.cellHeightPx * scale.y) : null,
    rowsDetected: pitch.rowYCenters.length,
    rowsExpected: truth?.rowCount ?? fixture.lines.length,
    rowOffsetCells,
    // Scored against the rows as displayed: with wrap on, a display row is a
    // piece of a line, and the grid is what these two measure.
    inkAccuracy: inkAccuracy(map, fixture.rows),
    indentAccuracy: indentAccuracy(map, fixture.rows),
    cer: null,
    numberAccuracy: null,
    markerErrorPx: null,
  };
}

/** The fixture's own points, as the camera simulation placed them in the frame. */
function mapThroughCamera(source: ImageData, framed: ImageData, points: Point[]): Point[] {
  void framed;
  const view = photograph(source);
  const h = computeHomography(
    [
      { x: 0, y: 0 },
      { x: source.width, y: 0 },
      { x: source.width, y: source.height },
      { x: 0, y: source.height },
    ],
    view.corners
  );
  return points.map((p) => applyHomography(h, p));
}

function pct(actual: number, expected: number): number {
  if (!Number.isFinite(actual) || expected === 0) return NaN;
  return ((actual - expected) / expected) * 100;
}

let atlasCache: GlyphAtlas | null | undefined;

/** The generated atlas, when one has been built into public/atlas/. */
export function loadAtlas(): GlyphAtlas | null {
  if (atlasCache !== undefined) return atlasCache;

  const dir = join(repoRoot, "public", "atlas");
  const manifestPath = join(dir, "atlas-manifest.json");
  const imagePath = join(dir, "atlas.png");
  if (!existsSync(manifestPath) || !existsSync(imagePath)) {
    atlasCache = null;
    return null;
  }

  const manifest: AtlasManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const png = PNG.sync.read(readFileSync(imagePath));
  const image = makeImageData(png.width, png.height, new Uint8ClampedArray(png.data));
  atlasCache = buildAtlasFromImageData(image, manifest);
  return atlasCache;
}
