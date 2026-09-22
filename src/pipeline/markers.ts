import { luminance, luminanceHistogram, otsuOfHistogram } from "./imageUtils";
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

/** Pixels past an edge, on the pane's side of it, that make a point the pane's ink rather than the arm's. */
const INTRUSION_PX = 1;

/** Times the edge along the pane is refitted with the pane's ink taken out. */
const ENVELOPE_PASSES = 4;

/** The four are drawn the same size; a tilted shot may still show them this much apart. */
const SIZE_AGREEMENT = 1.6;

/** A pane covering less than this share of the frame was not what the shot was of. */
const MIN_PANE_FRACTION = 0.1;

/** Candidates tried per corner, from the largest down, against each anchor. */
const PER_CORNER_TRIES = 4;

/** Thresholds tried, spread evenly from ink-only up to the whole frame's split. */
const LADDER_LEVELS = 5;

/** Two readings name the same pane when no corner moves more than this share of the frame's diagonal. */
const AGREEMENT_FRACTION = 0.01;

/** How far a marker's edge may turn from the pane side it lies along. */
const ALIGNMENT_TOLERANCE = (10 * Math.PI) / 180;

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

/** Where a reading stopped, when it did not reach a quad. */
export type MarkerOutcome =
  /** Four markers, and the pane they name. */
  | "found"
  /** Nothing in the frame was shaped like a marker. */
  | "no-candidates"
  /** Marker-shaped ink, but not one facing each of the four ways. */
  | "corners-missing"
  /** One of each, and no four of them together looked like a pane. */
  | "no-plausible-quad";

/**
 * What the detector saw, as well as what it concluded.
 *
 * A detector that answers only yes or no is one that can only be debugged by
 * whoever has both the failing photograph and the source - which, for a thing
 * that runs on a phone against a screen in someone else's office, is nobody.
 * Every stage that can discard a marker reports how much it discarded.
 */
export interface MarkerReport {
  quad: MarkerQuad | null;
  outcome: MarkerOutcome;
  /**
   * Luminance at or below which a pixel was taken for ink - at the level the
   * pane was read at, or the first level tried when it was not.
   */
  threshold: number;
  /** Dark blobs of a plausible size, before their shape was looked at. */
  blobs: number;
  /** Of those, the ones shaped like a marker, counted by the corner each names. */
  candidates: Record<Corner, number>;
  /** Sets of four put to the pane test. */
  quadsTried: number;
  /** Every threshold tried, in the order it was tried, and where each one got to. */
  levels: Array<{ threshold: number; outcome: MarkerOutcome }>;
  /** How many of those levels named the pane that was chosen; zero when none was. */
  agreeing: number;
  /** Wall-clock milliseconds, which is the number that decides whether this is usable on a phone. */
  ms: number;
}

/** One threshold's account of the frame. */
interface Reading {
  threshold: number;
  quad: MarkerQuad | null;
  outcome: MarkerOutcome;
  blobs: number;
  candidates: Record<Corner, number>;
  tried: number;
}

/**
 * Locates the pane by its corner markers, or returns null if fewer than four
 * are there to be found.
 */
export function detectMarkerQuad(image: ImageData): MarkerQuad | null {
  return inspectMarkers(image).quad;
}

/**
 * The same reading, with an account of how it got there.
 *
 * No one threshold separates a photographed marker from its surroundings on
 * every shot. The markers are drawn black, but a camera pointed at a monitor
 * brings them back anywhere from near-black to a mid grey, depending on glare
 * and moire - on the captures that prompted this, as light as the window
 * chrome, so a threshold low enough to leave the chrome out left only a
 * one-pixel sliver of each L in. Set it higher and it starts letting in the
 * toolbar's icons, whose outlines are L's as good as any.
 *
 * So the frame is read at several thresholds, stopping once two of them name
 * the same pane. A wrong quad is a coincidence - four pieces of ink that happen
 * to pass at one threshold - and it does not recur at the next level, where the
 * ink has grown or shrunk into other shapes. The real four do. When no two
 * levels agree, the pane named by the most of them is taken, since every one
 * has already passed every test a single reading can put it to.
 */
export function inspectMarkers(image: ImageData): MarkerReport {
  const started = Date.now();
  const { width, height } = image;

  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = luminance(image.data[p], image.data[p + 1], image.data[p + 2]);
  }

  const tolerance = Math.hypot(width, height) * AGREEMENT_FRACTION;
  const buffers = { seen: new Uint8Array(width * height), stack: [] as number[] };
  const readings: Reading[] = [];
  for (const threshold of thresholdLadder(gray)) {
    const reading = readAt(gray, width, height, threshold, buffers);
    readings.push(reading);
    if (reading.quad && agreementWith(reading.quad, readings, tolerance) >= 2) break;
  }

  // The pane most levels agree on; on a tie, the one read nearest the middle
  // of the ladder, which is where the ladder starts.
  let chosen: Reading | null = null;
  let agreeing = 0;
  for (const reading of readings) {
    if (!reading.quad) continue;
    const votes = agreementWith(reading.quad, readings, tolerance);
    if (votes > agreeing) {
      chosen = reading;
      agreeing = votes;
    }
  }

  const shown = chosen ?? readings[0];
  return {
    quad: chosen?.quad ?? null,
    outcome: shown.outcome,
    threshold: shown.threshold,
    blobs: shown.blobs,
    candidates: shown.candidates,
    quadsTried: shown.tried,
    levels: readings.map((r) => ({ threshold: r.threshold, outcome: r.outcome })),
    agreeing,
    ms: Date.now() - started,
  };
}

/** How many of the readings name this pane, counting the one it came from. */
function agreementWith(quad: MarkerQuad, readings: Reading[], tolerance: number): number {
  let votes = 0;
  for (const other of readings) {
    if (!other.quad) continue;
    const same = quad.corners.every(
      (corner, i) => Math.hypot(corner.x - other.quad!.corners[i].x, corner.y - other.quad!.corners[i].y) <= tolerance
    );
    if (same) votes++;
  }
  return votes;
}

/**
 * The thresholds to try, in the order to try them.
 *
 * They run from the ink-only split - the darkest a marker is ever read at -
 * up to the split of the whole frame into dark and light, past which the white
 * around the markers starts to go too. Middle first, then outward: the middle
 * of that range is where a photographed marker most often is.
 */
function thresholdLadder(gray: Float32Array): number[] {
  const histogram = luminanceHistogram(gray);
  const whole = otsuOfHistogram(histogram);
  const inkOnly = inkOnlyThreshold(histogram, whole);

  const levels: number[] = [];
  for (let i = 0; i < LADDER_LEVELS; i++) {
    const level = Math.round(inkOnly + ((whole - inkOnly) * i) / (LADDER_LEVELS - 1));
    if (!levels.includes(level)) levels.push(level);
  }

  const middle = (levels.length - 1) >> 1;
  const order: number[] = [levels[middle]];
  for (let step = 1; order.length < levels.length; step++) {
    if (middle + step < levels.length) order.push(levels[middle + step]);
    if (middle - step >= 0) order.push(levels[middle - step]);
  }
  return order;
}

/** The frame read at one threshold: its candidates, and the pane they make if they make one. */
function readAt(
  gray: Float32Array,
  width: number,
  height: number,
  threshold: number,
  buffers: { seen: Uint8Array; stack: number[] }
): Reading {
  const maxSide = Math.min(width, height) * MAX_SIDE_FRACTION;
  const blobs = connectedBlobs(gray, width, height, threshold, maxSide, buffers);

  const candidates: Array<{ blob: Blob; corner: Corner }> = [];
  for (const blob of blobs) {
    const corner = classify(blob);
    if (corner) candidates.push({ blob, corner });
  }

  const counts = { tl: 0, tr: 0, br: 0, bl: 0 } as Record<Corner, number>;
  for (const candidate of candidates) counts[candidate.corner]++;

  const search = chooseQuad(candidates, width, height);
  const quad = search.fits
    ? { corners: CORNERS.map((corner) => search.fits![corner].corner) as [Point, Point, Point, Point], found: 4 }
    : null;

  return {
    threshold,
    quad,
    outcome: outcomeOf(quad, candidates.length, counts),
    blobs: blobs.length,
    candidates: counts,
    tried: search.tried,
  };
}

function outcomeOf(quad: MarkerQuad | null, candidates: number, counts: Record<Corner, number>): MarkerOutcome {
  if (quad) return "found";
  if (candidates === 0) return "no-candidates";
  return CORNERS.some((corner) => counts[corner] === 0) ? "corners-missing" : "no-plausible-quad";
}

/**
 * Picks the four candidates that are the markers, out of however many pieces of
 * the frame happened to be L-shaped.
 *
 * The four cannot be recognised one at a time. A photographed marker is blurred,
 * compressed and thresholded until its arms are thinner than they were drawn,
 * while the editor is full of crisp glyphs - an L, a J, a 7 - that are better
 * L's than it is by every measure a single blob offers. Score them individually
 * and the best candidate for a corner is reliably a letter: on the photo
 * fixtures the real markers rank second, second, fifth and tenth of their
 * corner groups. Whichever way the tie is broken, one wrong pick is enough.
 *
 * What the markers have that scattered text does not is each other. They are
 * drawn the same size, one to a corner, around a pane - so the four are tested
 * as a set, and no blob is judged a marker on its own account at all.
 *
 * The search runs largest first, which needs no justifying beyond what the
 * markers are: they are drawn around the pane, so any four pieces of text that
 * happen to form a quad form a smaller one, inside it.
 */
function chooseQuad(
  candidates: Array<{ blob: Blob; corner: Corner }>,
  width: number,
  height: number
): { fits: Record<Corner, Fit> | null; tried: number } {
  let tried = 0;
  if (candidates.length < 4) return { fits: null, tried };

  // Each corner's candidates, largest first, sorted once: every size window
  // below is then a slice of one of these rather than a pass over all of them.
  const byCorner = {} as Record<Corner, Sized[]>;
  for (const corner of CORNERS) byCorner[corner] = [];
  for (const candidate of candidates) {
    byCorner[candidate.corner].push({ blob: candidate.blob, side: sideOf(candidate.blob) });
  }
  for (const corner of CORNERS) {
    if (byCorner[corner].length === 0) return { fits: null, tried };
    byCorner[corner].sort((a, b) => b.side - a.side);
  }

  const anchors = CORNERS.flatMap((corner) => byCorner[corner].map((c) => ({ ...c, corner })));
  anchors.sort((a, b) => b.side - a.side);

  // A blob is fitted once however many quads it is tried in, and only once it
  // has been part of one that passed everything cheaper.
  const fitted = new Map<Blob, Fit>();
  const fitOf = (blob: Blob, corner: Corner) => {
    let fit = fitted.get(blob);
    if (!fit) {
      fit = fitCorner(blob, corner);
      fitted.set(blob, fit);
    }
    return fit;
  };

  for (const anchor of anchors) {
    // Nothing larger than the anchor, since the anchor is the quad's largest
    // member and every larger candidate has already had its turn as one.
    const floor = anchor.side / SIZE_AGREEMENT;
    const choices = CORNERS.map((corner) =>
      corner === anchor.corner ? [anchor] : window(byCorner[corner], floor, anchor.side)
    );
    if (choices.some((list) => list.length === 0)) continue;

    for (const [tl, tr, br, bl] of combinations(choices)) {
      tried++;
      const assignment = { tl: tl.blob, tr: tr.blob, br: br.blob, bl: bl.blob };
      if (!plausiblePane(assignment, width, height)) continue;

      const fits = {
        tl: fitOf(tl.blob, "tl"),
        tr: fitOf(tr.blob, "tr"),
        br: fitOf(br.blob, "br"),
        bl: fitOf(bl.blob, "bl"),
      };
      if (alongThePane(fits)) return { fits, tried };
    }
  }
  return { fits: null, tried };
}

/**
 * Pane sides, as the pair of corners at either end, that each marker's two
 * outer edges lie along: its horizontal edge first, then its vertical one.
 */
const SIDES_OF: Record<Corner, [[Corner, Corner], [Corner, Corner]]> = {
  tl: [
    ["tl", "tr"],
    ["tl", "bl"],
  ],
  tr: [
    ["tl", "tr"],
    ["tr", "br"],
  ],
  br: [
    ["bl", "br"],
    ["tr", "br"],
  ],
  bl: [
    ["bl", "br"],
    ["tl", "bl"],
  ],
};

/**
 * Whether each marker's arms run along the sides of the pane the four make.
 *
 * The overlay draws every L with its outer edges flush with the pane's edges,
 * so they lie on the pane's sides - at any angle the screen is photographed
 * from, since a straight line stays straight in a photograph. Four blobs that
 * are not the markers can pass every other test here, each L-shaped and the
 * four of them a sensible quad, but their edges point wherever that ink
 * happened to point: on the captures that prompted this, a toolbar icon read
 * as the top-left marker had its left edge forty degrees off the pane's.
 */
function alongThePane(fits: Record<Corner, Fit>): boolean {
  for (const corner of CORNERS) {
    const edges = [fits[corner].horizontal, fits[corner].vertical];
    for (let k = 0; k < 2; k++) {
      const edge = edges[k];
      if (!edge) return false;

      const [from, to] = SIDES_OF[corner][k];
      const a = fits[from].corner;
      const b = fits[to].corner;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length === 0) return false;

      // Lines, not directions: which way along the side the fit points is arbitrary.
      const cosine = Math.abs(edge.dx * (b.x - a.x) + edge.dy * (b.y - a.y)) / length;
      if (cosine < Math.cos(ALIGNMENT_TOLERANCE)) return false;
    }
  }
  return true;
}

interface Sized {
  blob: Blob;
  side: number;
}

/**
 * The largest few candidates whose size is within the anchor's, from a list
 * already sorted largest first.
 *
 * Largest rather than best-shaped, deliberately: shape is what got every
 * candidate this far and it cannot separate a marker from a letter. Size can -
 * the markers are drawn at one size around the pane, and text is smaller than
 * they are.
 */
function window(sorted: Sized[], floor: number, ceiling: number): Sized[] {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid].side > ceiling) low = mid + 1;
    else high = mid;
  }

  const picked: Sized[] = [];
  for (let i = low; i < sorted.length && picked.length < PER_CORNER_TRIES; i++) {
    if (sorted[i].side < floor) break;
    picked.push(sorted[i]);
  }
  return picked;
}

/** Every way of taking one from each list, best-scoring combinations first. */
function* combinations<T>(lists: T[][]): Generator<T[]> {
  const counts = lists.map((list) => list.length);
  const total = counts.reduce((a, b) => a * b, 1);
  for (let i = 0; i < total; i++) {
    let rest = i;
    const pick: T[] = [];
    for (let k = 0; k < lists.length; k++) {
      pick.push(lists[k][rest % counts[k]]);
      rest = Math.floor(rest / counts[k]);
    }
    yield pick;
  }
}

/** The longer side of a blob's bounding box: what "the same size" is measured on. */
function sideOf(blob: Blob): number {
  return Math.max(blob.maxX - blob.minX, blob.maxY - blob.minY) + 1;
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
  const sides = CORNERS.map((c) => sideOf(assignment[c]));
  if (Math.max(...sides) / Math.min(...sides) > SIZE_AGREEMENT) return false;

  const centre = (blob: Blob) => ({ x: (blob.minX + blob.maxX) / 2, y: (blob.minY + blob.maxY) / 2 });
  const tl = centre(assignment.tl);
  const tr = centre(assignment.tr);
  const br = centre(assignment.br);
  const bl = centre(assignment.bl);

  // Convex, in order. Four markers around a pane always are, at any angle the
  // pane can be photographed from, and it is their shapes that put them in this
  // order - so this is also what catches a shape read wrong: a marker mistaken
  // for the corner diagonally opposite swaps two of the four and the quad
  // crosses itself.
  if (!isConvex([tl, tr, br, bl])) return false;

  // Each one on the side of the middle its shape claims it is on. Convexity
  // alone does not say this: it holds for the same four points read in the same
  // order whatever angle they are seen from, so four pieces of text can be a
  // convex quad whose "top right" sits at the bottom left. Requiring the two
  // independent accounts - which way the L points, where it sits - to agree is
  // what a real set of four always manages and scattered ink does not.
  const middle = {
    x: (tl.x + tr.x + br.x + bl.x) / 4,
    y: (tl.y + tr.y + br.y + bl.y) / 4,
  };
  if (!(tl.x < middle.x && tl.y < middle.y)) return false;
  if (!(tr.x > middle.x && tr.y < middle.y)) return false;
  if (!(br.x > middle.x && br.y > middle.y)) return false;
  if (!(bl.x < middle.x && bl.y > middle.y)) return false;

  // How much of the frame the quad covers, which is the question this test is
  // named for. Measuring each axis separately answers a different one and gets
  // it wrong both ways: a sliver can be wide and tall while enclosing almost
  // nothing, and a pane photographed in portrait is short against the frame's
  // height however well it fills the shot.
  return area([tl, tr, br, bl]) >= width * height * MIN_PANE_FRACTION;
}

/** Area of a quadrilateral, by the shoelace formula. */
function area(quad: Point[]): number {
  let sum = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Whether a quadrilateral turns the same way at every corner. */
function isConvex(quad: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const turn = cross > 0 ? 1 : -1;
    if (sign === 0) sign = turn;
    else if (turn !== sign) return false;
  }
  return sign !== 0;
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
 * grey, and leaves the blur between them out of both. What survives is ink -
 * when the markers photograph black. When glare lifts them to the chrome's
 * grey, it is the bottom of the ladder rather than the one threshold used.
 */
function inkOnlyThreshold(histogram: number[], whole: number): number {
  const dark = histogram.map((count, level) => (level <= whole ? count : 0));
  return dark.some((count) => count > 0) ? otsuOfHistogram(dark) : whole;
}

/**
 * Decides whether a blob is a marker, and if so which corner it names.
 *
 * An L covers two edges of its box that meet at one corner, so three quadrants
 * have ink and the fourth, diagonally opposite that corner, has none. That is
 * what separates a marker from a letter, a window border or a shadow, and it
 * reads the same at any distance: it is all ratios.
 */
function classify(blob: Blob): Corner | null {
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
  return CORNER_BY_EMPTY_QUADRANT[emptyQuadrant];
}

/**
 * The pane corner a marker names: where its two long outer edges meet.
 *
 * Every pixel along each edge votes on where that edge is, so a fitted corner
 * survives a ragged pixel or two at the tip of an arm - which a bounding box,
 * decided entirely by its extremes, does not.
 */
function fitCorner(blob: Blob, corner: Corner): Fit {
  const alongTop = corner === "bl" || corner === "br";
  const alongLeft = corner === "tl" || corner === "bl";

  const horizontal: Point[] = [];
  const width = blob.maxX - blob.minX + 1;
  for (let i = 0; i < width; i++) {
    const y = alongTop ? blob.topOf[i] : blob.bottomOf[i];
    if (y >= 0) horizontal.push({ x: blob.minX + i, y });
  }

  // The pane is below a top marker and above a bottom one. Its own ink - the
  // last line of text, cut off by the pane's bottom edge, is the usual one -
  // can blur into the arm lying along that edge, and is always on that side.
  const paneSide = alongTop ? -1 : 1;
  const a = fitAlongPane(trim(horizontal), paneSide);

  // The other arm runs away from the pane, so a row on the pane's side of the
  // first edge is not part of it, whatever ink the blob took in there.
  const vertical: Point[] = [];
  const height = blob.maxY - blob.minY + 1;
  for (let i = 0; i < height; i++) {
    const x = alongLeft ? blob.leftOf[i] : blob.rightOf[i];
    if (x < 0) continue;
    const point = { x, y: blob.minY + i };
    if (a && beyond(a, point) * paneSide > INTRUSION_PX) continue;
    vertical.push(point);
  }

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
    corner: {
      x: found.x + (alongLeft ? 0 : 1),
      y: found.y + (alongTop ? 0 : 1),
    },
    horizontal: a,
    vertical: b,
  };
}

/** Where a marker puts its pane corner, and the two outer edges that say so. */
interface Fit {
  corner: Point;
  horizontal: Line | null;
  vertical: Line | null;
}

/**
 * The edge of the arm that lies along the pane, fitted to the arm alone.
 *
 * The overlay puts that edge flush with the pane's, so whatever the pane shows
 * there is a pixel away - on real captures, the tops of the glyphs on the
 * half-visible last line, which blur into the bottom markers' arms. The blob
 * then runs on into them, and its outermost ink along some stretch of the edge
 * is theirs. Fitted with the rest, they tilted the bottom-left marker's edge by
 * up to twenty degrees and moved its corner seven pixels.
 *
 * They can be told apart by where they are: always past the arm's edge on the
 * pane's side, never on the other. So the edge is fitted, whatever sticks out
 * past it on the pane's side is taken to be the pane's, and it is fitted again
 * without it, until nothing more comes out. Counting points would not do - on
 * one capture the glyphs cover more of the edge than the arm does.
 */
function fitAlongPane(points: Point[], paneSide: number): Line | null {
  let kept = points;
  let line = fitLine(kept);
  for (let pass = 0; pass < ENVELOPE_PASSES && line; pass++) {
    const fitted = line;
    const arm = kept.filter((p) => beyond(fitted, p) * paneSide <= INTRUSION_PX);
    if (arm.length === kept.length || arm.length < 2) break;
    kept = arm;
    line = fitLine(kept);
  }
  return line;
}

/** How far below a near-horizontal line a point is, in pixels; negative above it. */
function beyond(line: Line, p: Point): number {
  // The normal that points down the image, whichever way the fit ran.
  const flip = line.dx < 0 ? -1 : 1;
  return flip * ((p.y - line.point.y) * line.dx - (p.x - line.point.x) * line.dy);
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
  maxSide: number,
  buffers: { seen: Uint8Array; stack: number[] }
): Blob[] {
  // Allocated once per frame and cleared here: the frame is read at several
  // thresholds, and a phone would rather not collect megabytes for each one.
  const { seen, stack } = buffers;
  seen.fill(0);
  stack.length = 0;
  const blobs: Blob[] = [];

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
