import { calibrateCellPitch, type CellPitch } from "./calibrate";
import { detectMargins, type Framing, type MarginBounds } from "./margins";
import type { GlyphAtlas } from "./match";
import { gridFromProfile, type GridProfile } from "./profileGrid";
import { rectifyFrame, type Intrinsics, type OutputSizing, type Point, type Rectified } from "./rectify";
import { buildRows, type LineRow } from "../model/lineIndex";

/**
 * How big every capture is rectified to, in the app and in the metrics run
 * alike. See OutputSizing.
 *
 * A fixed width, so a pane of a given size comes out at one scale whatever
 * distance it was taken from. Twice the pane's own size was tried in its
 * place and measured worse: the grid estimator, which is what reads a capture
 * whenever the screen profile cannot be used, took the real photographs from a
 * median 41% character error to around 100% at that scale, and 1.6 times was
 * no better than this.
 */
export const RECTIFIED_SIZING: OutputSizing = { kind: "fixed", width: 1600 };

/** The screen's own account of the grid, and the pane it is measured in. */
export interface KnownGrid {
  grid: GridProfile;
  pane: { width: number; height: number };
}

/** What the screen side said about the pane: its size, and its grid when that could be read. */
export interface ScreenFacts {
  pane: { width: number; height: number };
  grid: GridProfile | null;
}

export interface Prepared {
  rectified: Rectified;
  /** The grid to lay out, when there is one still worth trying. */
  known: KnownGrid | null;
  /** Anything the screen side said that was not used, and why. */
  notes: string[];
}

/**
 * The capture flattened for reading, and what of the screen profile still
 * holds for it.
 *
 * The pane's size sets the output's proportions and scale, unless the camera
 * says the pane is some other shape - then the window has been resized since
 * the profile was printed, and neither its size nor its grid is used. The app
 * and the metrics run both come through here, so a profile is trusted or set
 * aside by the same rule in both.
 */
export function prepareCapture(
  image: ImageData,
  corners: Point[],
  options: { facts: ScreenFacts | null; intrinsics?: Intrinsics; sizing?: OutputSizing }
): Prepared | null {
  const { facts } = options;
  const base = options.sizing ?? RECTIFIED_SIZING;
  const sizing: OutputSizing = base.kind === "source" && facts ? { ...base, paneSize: facts.pane } : base;

  const rectified = rectifyFrame(image, corners, {
    sizing,
    intrinsics: options.intrinsics,
    knownAspect: facts ? facts.pane.width / facts.pane.height : undefined,
  });
  if (!rectified) return null;

  const notes: string[] = [];
  const setAside = rectified.aspect.setAside;
  if (setAside !== undefined) {
    notes.push(
      `screen profile set aside: the camera puts the pane at ${rectified.aspect.aspect.toFixed(3)} wide to 1 high, ` +
        `the profile at ${setAside.toFixed(3)}, so the window has changed since it was printed`
    );
  }
  const known = facts?.grid && setAside === undefined ? { grid: facts.grid, pane: facts.pane } : null;
  return { rectified, known, notes };
}

/**
 * Where the grid came from. "profile": laid out from the screen's numbers.
 * "estimated": searched for in the photograph, because there were no numbers
 * or the photograph disagreed with them.
 */
export type GridSource = "profile" | "estimated";

export interface Analysis {
  margins: MarginBounds | null;
  pitch: CellPitch | null;
  /** Null when there is no grid. */
  gridSource: GridSource | null;
  /** Null when recognition could not run: no atlas, or no usable grid. */
  rows: LineRow[] | null;
  /** What was found, a line per fact, for the result screen. */
  summary: string[];
}

/**
 * Everything read from a rectified capture: where the body is, the character
 * grid, and the text in it.
 *
 * The grid comes from the screen profile when there is one, the capture is
 * the pane itself, and the text agrees with it. Failing any of those it is
 * estimated from the text, as it always was, and the summary says why - so a
 * profile that could not be used costs a slower read, never a wrong one.
 *
 * Only ever given the rectified pixels themselves, and never writes to them.
 * Whatever is drawn to show the result - the grid, the margins - goes on a
 * layer of its own; drawn onto these pixels it would be read back as ink, and
 * the first row and every blank cell next to a grid line would come back as
 * something they are not.
 */
export function analyzeCapture(
  image: ImageData,
  framing: Framing,
  atlas: GlyphAtlas | null,
  known: KnownGrid | null = null
): Analysis {
  const summary: string[] = [];
  let margins: MarginBounds | null = null;
  let pitch: CellPitch | null = null;
  let gridSource: GridSource | null = null;

  if (known && framing !== "pane") {
    summary.push("screen profile not used: the corners were placed by hand, so the image need not be the pane");
  } else if (known) {
    const laid = gridFromProfile(image, known.grid, known.pane);
    const { check } = laid;
    if (check.agrees && usable(laid.pitch)) {
      margins = laid.margins;
      pitch = laid.pitch;
      gridSource = "profile";
      summary.push(
        `grid: from the screen profile, spacing x${laid.stretch.x.toFixed(3)} across and ` +
          `x${laid.stretch.y.toFixed(3)} down, columns moved ${laid.shift.toFixed(2)} cell` +
          (check.evidence ? `, text agrees (best width x${check.bestRatio.toFixed(3)})` : ", too blurred to check")
      );
    } else if (!check.agrees) {
      summary.push(
        `screen profile set aside: the text lines up at x${check.bestRatio.toFixed(3)} its cell width, ` +
          "so the font or zoom has changed since it was printed; estimating instead"
      );
    } else {
      summary.push("screen profile set aside: it leaves no rows with text on them; estimating instead");
    }
  }

  if (!pitch) {
    try {
      margins = detectMargins(image, framing);
      pitch = calibrateCellPitch(image, margins);
      gridSource = "estimated";
      if (!usable(pitch)) {
        summary.push("grid not drawn: calibration did not resolve a usable cell pitch");
        pitch = null;
        gridSource = null;
      }
    } catch (err) {
      summary.push(`pipeline error: ${(err as Error).message}`);
      margins = null;
      pitch = null;
      gridSource = null;
    }
  }

  if (margins) {
    summary.push(`body: y ${Math.round(margins.bodyTopY)}–${Math.round(margins.bodyBottomY)}`);
    summary.push(`gutter edge: x=${Math.round(margins.gutterRightEdgeX)}, text right: x=${Math.round(margins.textAreaRightX)}`);
  }
  if (pitch) {
    summary.push(
      `cell pitch: ${pitch.widthPx.toFixed(2)} x ${pitch.heightPx.toFixed(2)} px (${gridSource}), rows: ${pitch.rowYCenters.length}`
    );
  }

  const rows = margins && pitch && atlas ? buildRows(image, margins, pitch, atlas) : null;
  return { margins, pitch, gridSource, rows, summary };
}

function usable(pitch: CellPitch): boolean {
  return Number.isFinite(pitch.widthPx) && pitch.widthPx > 0 && Number.isFinite(pitch.heightPx) && pitch.rowYCenters.length > 0;
}
