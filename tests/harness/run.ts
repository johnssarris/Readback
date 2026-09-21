import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { calibrateCellPitch, type CellPitch } from "../../src/pipeline/calibrate";
import { detectMargins, type MarginBounds } from "../../src/pipeline/margins";
import { buildAtlasFromImageData, type AtlasManifest, type GlyphAtlas } from "../../src/pipeline/match";
import { estimateAspectRatio, warpImageData, type Point } from "../../src/pipeline/rectify";
import { buildRows, rowsToText } from "../../src/model/lineIndex";
import { photograph, type CameraOptions } from "./degrade";
import type { Fixture } from "./cases";
import { makeImageData } from "./image";
import {
  characterErrorRate,
  inkAccuracy,
  indentAccuracy,
  inkMap,
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
    // Already a photograph; its corners have to come from the sidecar.
    if (!fixture.meta.corners) {
      throw new Error(`Fixture ${fixture.name} is a photo but has no corners in its sidecar JSON`);
    }
    image = source;
    corners = fixture.meta.corners;
  } else if (mode === "camera") {
    const view = photograph(source, camera);
    image = view.image;
    corners = view.corners;
  } else {
    image = source;
    corners = fixture.meta.corners ?? [
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

  const margins = detectMargins(rectified);
  const pitch = calibrateCellPitch(rectified, margins);

  const scale = { x: DEST_WIDTH / source.width, y: destHeight / source.height };
  const metrics = score(fixture, rectified, margins, pitch, scale);

  let text: string | null = null;
  const atlas = loadAtlas();
  if (atlas && Number.isFinite(pitch.widthPx) && pitch.widthPx > 0 && pitch.rowYCenters.length > 0) {
    text = rowsToText(buildRows(rectified, margins, pitch, atlas));
    metrics.cer = characterErrorRate(text, fixture.lines.join("\n"));
  }

  return { margins, pitch, metrics, text, rectified, scale };
}

function score(
  fixture: Fixture,
  rectified: ImageData,
  margins: MarginBounds,
  pitch: CellPitch,
  scale: { x: number; y: number }
): Metrics {
  const truth = fixture.meta.truth;

  const columns =
    Number.isFinite(pitch.widthPx) && pitch.widthPx > 0
      ? Math.floor((margins.textAreaRightX - margins.textAreaLeftX) / pitch.widthPx)
      : 0;
  const map = columns > 0 ? inkMap(rectified, margins, pitch, columns) : [];

  let rowOffsetCells: number | null = null;
  if (truth && truth.rowYCenters.length > 0 && pitch.rowYCenters.length > 0 && pitch.heightPx > 0) {
    const n = Math.min(truth.rowYCenters.length, pitch.rowYCenters.length);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += Math.abs(pitch.rowYCenters[i] - truth.rowYCenters[i] * scale.y);
    }
    rowOffsetCells = sum / n / pitch.heightPx;
  }

  return {
    bodyTopErrorPx: truth ? margins.bodyTopY - truth.bodyTopY * scale.y : null,
    bodyBottomErrorPx: truth ? margins.bodyBottomY - truth.bodyBottomY * scale.y : null,
    gutterEdgeErrorPx: truth ? margins.gutterRightEdgeX - truth.gutterRightEdgeX * scale.x : null,
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
  };
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
