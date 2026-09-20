import { findRuns, luminance, median, otsuThreshold } from "./imageUtils";
import type { MarginBounds } from "./margins";

export interface CellPitch {
  widthPx: number;
  heightPx: number;
  /** Vertical center (in full rectified-image coordinates) of each detected gutter row. */
  rowYCenters: number[];
}

/** Typical width/height ratio of a JetBrains Mono cell; used only as a seed for iterative digit-count refinement. */
const ASSUMED_ASPECT_RATIO = 0.6;

/** Rows whose digit blob is narrower than this fraction of the seed cell width are treated as blank
 *  (wrapped continuation lines, which Notepad++ leaves numberless) and excluded from width calibration. */
const MIN_BLOB_WIDTH_FRACTION = 0.4;

/**
 * Derives the actual on-image character cell pitch from the line-number gutter's own digits,
 * rather than trusting screen-side font/DPI constants (see plan: Design decisions,
 * "Self-calibrating cell pitch").
 */
export function calibrateCellPitch(image: ImageData, margins: MarginBounds): CellPitch {
  const { gutterLeftX, gutterRightEdgeX, bodyTopY, bodyBottomY } = margins;
  const cropWidth = gutterRightEdgeX - gutterLeftX;
  const cropHeight = bodyBottomY - bodyTopY;

  const gray = new Float32Array(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const i = ((bodyTopY + y) * image.width + (gutterLeftX + x)) * 4;
      gray[y * cropWidth + x] = luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
    }
  }

  const threshold = otsuThreshold(Array.from(gray));

  // Otsu convention: values <= threshold are one class, values > threshold the other.
  let belowCount = 0;
  for (const v of gray) if (v <= threshold) belowCount++;
  const foregroundIsBelow = belowCount <= gray.length - belowCount;

  const isForeground = (v: number) => (foregroundIsBelow ? v <= threshold : v > threshold);

  const rowProjection = new Array(cropHeight).fill(0);
  for (let y = 0; y < cropHeight; y++) {
    let count = 0;
    for (let x = 0; x < cropWidth; x++) {
      if (isForeground(gray[y * cropWidth + x])) count++;
    }
    rowProjection[y] = count;
  }

  const rowRuns = findRuns(rowProjection.map((c) => c > 0));
  const rowYCenters = rowRuns.map((r) => bodyTopY + (r.start + r.end) / 2);

  const heightDiffs: number[] = [];
  for (let i = 1; i < rowYCenters.length; i++) {
    heightDiffs.push(rowYCenters[i] - rowYCenters[i - 1]);
  }
  const cellHeightPx = median(heightDiffs);
  const seedWidth = cellHeightPx * ASSUMED_ASPECT_RATIO;

  const refinedWidths: number[] = [];
  for (const run of rowRuns) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < cropWidth; x++) {
      let hasForeground = false;
      for (let y = run.start; y < run.end; y++) {
        if (isForeground(gray[y * cropWidth + x])) {
          hasForeground = true;
          break;
        }
      }
      if (hasForeground) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    if (minX === -1) continue;

    const blobWidth = maxX - minX + 1;
    if (blobWidth < seedWidth * MIN_BLOB_WIDTH_FRACTION) continue;

    const digitCount = Math.max(1, Math.round(blobWidth / seedWidth));
    refinedWidths.push(blobWidth / digitCount);
  }

  const cellWidthPx = refinedWidths.length > 0 ? median(refinedWidths) : seedWidth;

  return { widthPx: cellWidthPx, heightPx: cellHeightPx, rowYCenters };
}
