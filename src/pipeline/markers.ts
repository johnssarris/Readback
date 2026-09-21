import { luminance, otsuThreshold } from "./imageUtils";
import { CORNERS, CORNER_BY_EMPTY_QUADRANT, FILL_RATIO, type Corner } from "./markerGeometry";
import type { Point } from "./rectify";

/**
 * Finding the four corner markers, and with them the editor pane.
 *
 * These four points define every measurement that follows - the cell grid is
 * laid out from them - so they are worth more care than a blob's bounding box
 * can give. A bounding box is decided by its extreme pixels, and the extreme
 * pixels of a photographed black bar are wherever the blur and the sensor noise
 * happened to land. Each corner is instead the intersection of two lines fitted
 * to the long outer edges of the L, every pixel along them voting.
 */

/** A marker's bounding box may be this far from square before it stops being one. */
const ASPECT_TOLERANCE = 0.4;

/** How far the ink in the box may be from an L's share of it. */
const FILL_TOLERANCE = 0.18;

/** A quadrant with less than this share of the ink of the fullest one is the empty one. */
const EMPTY_QUADRANT_SHARE = 0.25;

/** Shortest side a marker can have, in pixels, and its longest as a share of the frame. */
const MIN_SIDE_PX = 10;
const MAX_SIDE_FRACTION = 0.25;

/** Share of each outer edge dropped at either end before the line is fitted. */
const EDGE_TRIM = 0.1;

/** The four are drawn the same size; a tilted shot may still show them this much apart. */
const SIZE_AGREEMENT = 1.6;

/** A pane smaller than this share of the frame was not what the shot was of. */
const MIN_PANE_FRACTION = 0.25;

/** How far apart, in marker widths, two markers must be for their order to be clear. */
const SEPARATION = 1;

const NEIGHBOURS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export interface MarkerQuad {
  /** The pane's corners, clockwise from the top left. */
  corners: [Point, Point, Point, Point];
  /** How many of the four were found by their shape; four is a full reading. */
  found: number;
}

interface Blob {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pixels: number;
  /** Ink per quadrant of the bounding box, in reading order. */
  quadrants: [number, number, number, number];
  /** For each column, the topmost and bottommost inked row; -1 where the column has none. */
  topOf: Int32Array;
  bottomOf: Int32Array;
  /** For each row, the leftmost and rightmost inked column. */
  leftOf: Int32Array;
  rightOf: Int32Array;
}

/**
 * Locates the pane by its corner markers, or returns null if fewer than four
 * are there to be found.
 */
export function detectMarkerQuad(image: ImageData): MarkerQuad | null {
  const candidates = findMarkers(image);
  if (candidates.length < 4) return null;

  // Where the four sit relative to each other says which corner each one is,
  // and that is the reading to trust while it is clear. When it is not - a shot
  // tilted far enough that two of them are level, and which is the top pair
  // becomes a coin toss - the shape of the L says the same thing independently,
  // and it breaks the tie.
  const four = candidates.length > 4 ? bestPerShape(candidates) : candidates;
  if (!four || four.length !== 4) return null;

  const assignment = assignByPosition(four) ?? assignByShape(four);
  if (!assignment) return null;

  if (!plausiblePane(assignment, image.width, image.height)) return null;

  const corners = CORNERS.map((corner) => fitCorner(assignment[corner], corner));
  return { corners: corners as [Point, Point, Point, Point], found: 4 };
}

/**
 * Whether four candidates can really be four markers around one pane.
 *
 * Shape alone is not enough: a page of text contains L-shaped ink, and four
 * pieces of it can each pass the shape test on their own. What they cannot do
 * is look like four markers *together* - the four are drawn the same size, they
 * sit one to a corner in order, and they surround a pane big enough to have
 * been worth photographing.
 */
function plausiblePane(assignment: Record<Corner, Blob>, width: number, height: number): boolean {
  const sides = CORNERS.map((c) => {
    const blob = assignment[c];
    return Math.max(blob.maxX - blob.minX, blob.maxY - blob.minY) + 1;
  });
  if (Math.max(...sides) / Math.min(...sides) > SIZE_AGREEMENT) return false;

  const centre = (blob: Blob) => ({ x: (blob.minX + blob.maxX) / 2, y: (blob.minY + blob.maxY) / 2 });
  const tl = centre(assignment.tl);
  const tr = centre(assignment.tr);
  const br = centre(assignment.br);
  const bl = centre(assignment.bl);

  const spanX = Math.max(Math.abs(tr.x - tl.x), Math.abs(br.x - bl.x));
  const spanY = Math.max(Math.abs(bl.y - tl.y), Math.abs(br.y - tr.y));
  return spanX >= width * MIN_PANE_FRACTION && spanY >= height * MIN_PANE_FRACTION;
}

/** Every dark blob in the frame shaped like one of the markers. */
function findMarkers(image: ImageData): Array<{ blob: Blob; corner: Corner; score: number }> {
  const { width, height } = image;

  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = luminance(image.data[p], image.data[p + 1], image.data[p + 2]);
  }
  const threshold = inkOnlyThreshold(gray);

  const maxSide = Math.min(width, height) * MAX_SIDE_FRACTION;
  const found: Array<{ blob: Blob; corner: Corner; score: number }> = [];

  for (const blob of connectedBlobs(gray, width, height, threshold, maxSide)) {
    const shape = classify(blob);
    if (shape) found.push({ blob, corner: shape.corner, score: shape.score });
  }
  return found;
}

/**
 * A threshold that separates ink from everything else, rather than dark from light.
 *
 * Splitting the whole frame in two puts the window's chrome on the ink side,
 * and a marker's arm is flush with the pane edge, a pixel from it. That much is
 * survivable while the edge is sharp. In a photograph it is not: the chrome
 * blurs into the white pane across a few middling pixels, and those pixels are
 * a path - every marker joins the chrome and there is nothing marker-shaped
 * left to find.
 *
 * Splitting the dark side again separates the markers' black from the chrome's
 * grey, and leaves the blur between them out of both. What survives is ink.
 */
function inkOnlyThreshold(gray: Float32Array): number {
  const all = Array.from(gray);
  const first = otsuThreshold(all);
  const dark = all.filter((v) => v <= first);
  return dark.length > 0 ? otsuThreshold(dark) : first;
}

/**
 * Decides whether a blob is a marker, and if so which corner it names.
 *
 * An L covers two edges of its box that meet at one corner, so three quadrants
 * have ink and the fourth, diagonally opposite that corner, has none. That is
 * what separates a marker from a letter, a window border or a shadow, and it
 * reads the same at any distance: it is all ratios.
 */
function classify(blob: Blob): { corner: Corner; score: number } | null {
  const w = blob.maxX - blob.minX + 1;
  const h = blob.maxY - blob.minY + 1;
  if (w < MIN_SIDE_PX || h < MIN_SIDE_PX) return null;

  const aspect = w / h;
  if (Math.abs(aspect - 1) > ASPECT_TOLERANCE) return null;

  const fill = blob.pixels / (w * h);
  if (Math.abs(fill - FILL_RATIO) > FILL_TOLERANCE) return null;

  const quadrants = blob.quadrants;
  const fullest = Math.max(...quadrants);
  if (fullest === 0) return null;

  const empty = quadrants.map((q) => q / fullest < EMPTY_QUADRANT_SHARE);
  if (empty.filter(Boolean).length !== 1) return null;

  // Quadrants in reading order are tl, tr, bl, br of the marker's own box.
  const emptyQuadrant = (["tl", "tr", "bl", "br"] as Corner[])[empty.indexOf(true)];
  const corner = CORNER_BY_EMPTY_QUADRANT[emptyQuadrant];

  // How cleanly it is an L: the emptier the empty quadrant and the closer the
  // ink to an L's share, the better. Used only to choose between blobs that
  // both claim the same corner.
  const emptiness = 1 - quadrants[empty.indexOf(true)] / fullest;
  const fillScore = 1 - Math.abs(fill - FILL_RATIO) / FILL_TOLERANCE;
  return { corner, score: emptiness + fillScore };
}

/** The best-shaped candidate for each corner, when more than four look like markers. */
function bestPerShape(
  candidates: Array<{ blob: Blob; corner: Corner; score: number }>
): Array<{ blob: Blob; corner: Corner; score: number }> | null {
  const best = new Map<Corner, { blob: Blob; corner: Corner; score: number }>();
  for (const candidate of candidates) {
    const held = best.get(candidate.corner);
    if (!held || candidate.score > held.score) best.set(candidate.corner, candidate);
  }
  return best.size === 4 ? [...best.values()] : null;
}

/** Groups candidates by the corner their shape names, keeping the best of each. */
function assignByShape(
  candidates: Array<{ blob: Blob; corner: Corner; score: number }>
): Record<Corner, Blob> | null {
  const best = new Map<Corner, { blob: Blob; score: number }>();
  for (const candidate of candidates) {
    const held = best.get(candidate.corner);
    if (!held || candidate.score > held.score) {
      best.set(candidate.corner, { blob: candidate.blob, score: candidate.score });
    }
  }
  if (best.size !== 4) return null;

  const assignment = {} as Record<Corner, Blob>;
  for (const corner of CORNERS) assignment[corner] = best.get(corner)!.blob;
  return assignment;
}

/**
 * Assigns four candidates to corners by where they sit relative to each other,
 * or gives up if that is too close to call.
 *
 * Two markers being level is not a near miss to be resolved by rounding: it is
 * the question of which pair is the top one having no answer in their positions
 * at all. Better to say so and let the shapes decide than to pick one.
 */
function assignByPosition(
  candidates: Array<{ blob: Blob; corner: Corner; score: number }>
): Record<Corner, Blob> | null {
  if (candidates.length !== 4) return null;

  const centres = candidates.map(({ blob }) => ({
    blob,
    x: (blob.minX + blob.maxX) / 2,
    y: (blob.minY + blob.maxY) / 2,
    side: Math.max(blob.maxX - blob.minX, blob.maxY - blob.minY) + 1,
  }));
  const clear = Math.min(...centres.map((c) => c.side)) * SEPARATION;

  const byY = [...centres].sort((a, b) => a.y - b.y);
  if (byY[2].y - byY[1].y < clear) return null;

  const [tl, tr] = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const [bl, br] = byY.slice(2).sort((a, b) => a.x - b.x);
  if (tr.x - tl.x < clear || br.x - bl.x < clear) return null;

  return { tl: tl.blob, tr: tr.blob, br: br.blob, bl: bl.blob };
}

/**
 * The pane corner a marker names: where its two long outer edges meet.
 *
 * Every pixel along each edge votes on where that edge is, so a fitted corner
 * survives a ragged pixel or two at the tip of an arm - which a bounding box,
 * decided entirely by its extremes, does not.
 */
function fitCorner(blob: Blob, corner: Corner): Point {
  const alongTop = corner === "bl" || corner === "br";
  const alongLeft = corner === "tl" || corner === "bl";

  const horizontal: Point[] = [];
  const width = blob.maxX - blob.minX + 1;
  for (let i = 0; i < width; i++) {
    const y = alongTop ? blob.topOf[i] : blob.bottomOf[i];
    if (y >= 0) horizontal.push({ x: blob.minX + i, y });
  }

  const vertical: Point[] = [];
  const height = blob.maxY - blob.minY + 1;
  for (let i = 0; i < height; i++) {
    const x = alongLeft ? blob.leftOf[i] : blob.rightOf[i];
    if (x >= 0) vertical.push({ x, y: blob.minY + i });
  }

  const a = fitLine(trim(horizontal));
  const b = fitLine(trim(vertical));
  const crossing = a && b ? intersect(a, b) : null;

  const found = crossing ?? {
    x: alongLeft ? blob.minX : blob.maxX,
    y: alongTop ? blob.minY : blob.maxY,
  };

  // The fit runs through the centres of the outermost ink pixels, and the pane
  // edge is the far side of them. Which side that is depends on which way the
  // marker faces: a whole pixel of bias at every corner otherwise, always in
  // the same direction, which is exactly the kind that survives averaging.
  return {
    x: found.x + (alongLeft ? 0 : 1),
    y: found.y + (alongTop ? 0 : 1),
  };
}

/** Drops the ends of an edge, where the two arms meet and where the ink runs out. */
function trim(points: Point[]): Point[] {
  const cut = Math.floor(points.length * EDGE_TRIM);
  return points.length - 2 * cut >= 2 ? points.slice(cut, points.length - cut) : points;
}

interface Line {
  point: Point;
  dx: number;
  dy: number;
}

/**
 * Total least squares: the line through the points' centre along the direction
 * they vary most in. Unlike fitting y against x it has no trouble with a
 * vertical edge, and both edges of an L are vertical from one marker or another.
 */
function fitLine(points: Point[]): Line | null {
  if (points.length < 2) return null;

  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }

  // Principal direction: the eigenvector of the covariance matrix for its
  // larger eigenvalue.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: { x: mx, y: my }, dx: Math.cos(theta), dy: Math.sin(theta) };
}

function intersect(a: Line, b: Line): Point | null {
  const denominator = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(denominator) < 1e-9) return null;

  const t = ((b.point.x - a.point.x) * b.dy - (b.point.y - a.point.y) * b.dx) / denominator;
  return { x: a.point.x + a.dx * t, y: a.point.y + a.dy * t };
}

/**
 * Every run of touching dark pixels, with the per-row and per-column extremes
 * gathered as it goes, since the edges are needed later and the blob is already
 * in hand.
 */
function connectedBlobs(
  gray: Float32Array,
  width: number,
  height: number,
  threshold: number,
  maxSide: number
): Blob[] {
  const seen = new Uint8Array(width * height);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < gray.length; start++) {
    if (seen[start] || gray[start] > threshold) continue;

    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let pixels = 0;
    const members: number[] = [];

    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;

      members.push(index);
      pixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Four-connected, not eight. A marker's arm is flush with the edge of
      // the pane, and just across that edge is whatever surrounds it - often
      // dark. Diagonal steps bridge the two at exactly the pane corner, and
      // every marker ends up part of one blob with the window frame. Arms are
      // solid bars several pixels thick, so nothing of a marker is lost by
      // stepping only up, down, left and right.
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (seen[next] || gray[next] > threshold) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < MIN_SIDE_PX || h < MIN_SIDE_PX || w > maxSide || h > maxSide) continue;
    if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) continue;

    blobs.push(summarise(members, width, minX, maxX, minY, maxY, pixels));
  }
  return blobs;
}

function summarise(
  members: number[],
  width: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  pixels: number
): Blob {
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  const topOf = new Int32Array(w).fill(-1);
  const bottomOf = new Int32Array(w).fill(-1);
  const leftOf = new Int32Array(h).fill(-1);
  const rightOf = new Int32Array(h).fill(-1);
  const quadrants: [number, number, number, number] = [0, 0, 0, 0];

  for (const index of members) {
    const x = index % width;
    const y = (index - x) / width;
    const col = x - minX;
    const row = y - minY;

    if (topOf[col] < 0 || y < topOf[col]) topOf[col] = y;
    if (y > bottomOf[col]) bottomOf[col] = y;
    if (leftOf[row] < 0 || x < leftOf[row]) leftOf[row] = x;
    if (x > rightOf[row]) rightOf[row] = x;

    const right = col >= w / 2 ? 1 : 0;
    const lower = row >= h / 2 ? 2 : 0;
    quadrants[right + lower]++;
  }

  return { minX, maxX, minY, maxY, pixels, quadrants, topOf, bottomOf, leftOf, rightOf };
}
