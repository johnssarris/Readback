import { luminance, resampleToGray, soften, type Rect } from "./imageUtils";

export interface AtlasManifest {
  /** The face the templates were rendered from; the editor being photographed has to match it. */
  font?: string;
  fontFamily?: string;
  cellWidth: number;
  cellHeight: number;
  /** Where the baseline sits inside a cell, as a fraction of its height. */
  baselineFraction?: number;
  canvasWidth: number;
  canvasHeight: number;
  fontSize: number;
  sprites: Record<string, Rect>;
}

export interface GlyphAtlas {
  cellWidth: number;
  cellHeight: number;
  /** Where the baseline sits inside a template cell, as a fraction of its height. */
  baselineFraction?: number;
  glyphs: Map<string, Float32Array>;
}

export interface MatchCandidate {
  char: string;
  score: number;
}

export interface MatchResult {
  char: string;
  confidence: number;
  candidates: MatchCandidate[];
  flagged: boolean;
}

/** Below this confidence, a cell is treated as unrecognized rather than force-matched. */
export const CONFIDENCE_FLOOR = 0.55;

/** If best and second-best scores are closer than this, the match is ambiguous and flagged. */
export const MARGIN_THRESHOLD = 0.08;

const CANDIDATE_LIMIT = 5;

/**
 * Luminance range below which a cell is taken to hold no glyph at all.
 *
 * Correlation cannot answer this one. A blank cell is flat, so it correlates
 * with nothing - every template scores the same, and the winner is whichever
 * happens to be first. The space template is flat too, so a space can never win
 * on correlation even against a blank cell. The contrast between a cell's
 * darkest and brightest pixel settles it instead: any glyph, however light,
 * puts ink well below the page it sits on, while a blank cell varies only by
 * sensor noise.
 */
export const BLANK_CONTRAST = 48;

/**
 * Share of a cell's width the blank test looks at, centred.
 *
 * A wide glyph's ink reaches the edge of its own cell and, once a photograph
 * has blurred it, a little way into the next one. Measured across the whole
 * cell that borrowed ink is contrast, and a space beside an m or a W stops
 * reading as blank - it comes back as r, W, a or {, whichever template the
 * fringe happens to suit. The middle of a cell belongs to that cell alone.
 */
const BLANK_REGION = 0.6;

/**
 * How far the templates are softened before anything is compared to them, as a
 * share of a template cell's width.
 *
 * The templates come off a vector face at a size of their own choosing, so their
 * edges are as sharp as the format allows. Nothing photographed through a lens
 * is, and correlation is a comparison of whole images: a sharp template and a
 * soft cell disagree along every edge in the glyph, which is most of what a
 * glyph is. The disagreement is much the same for every template, so the scores
 * of all of them collapse together - on the photo fixtures the correct
 * character was beaten by a margin of 0.003 while sitting second or third.
 *
 * Softening the templates to something a camera could have produced is matching
 * the template to the measurement rather than the measurement to the template.
 * Measured over the fixtures, it is worth 13 to 16 points of character accuracy
 * on a photograph and nothing either way on a render, which has no blur to
 * match; the figure below is the widest setting that still costs a render
 * nothing.
 */
const TEMPLATE_SOFTENING = 3 / 28;

/** Builds a runtime glyph atlas (grayscale bitmaps) from the generated sprite sheet + manifest. */
export function buildAtlasFromImageData(atlasImage: ImageData, manifest: AtlasManifest): GlyphAtlas {
  const glyphs = new Map<string, Float32Array>();
  const radius = Math.round(manifest.cellWidth * TEMPLATE_SOFTENING);

  for (const [char, rect] of Object.entries(manifest.sprites)) {
    const gray = new Float32Array(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const i = ((rect.y + y) * atlasImage.width + (rect.x + x)) * 4;
        gray[y * rect.w + x] = luminance(atlasImage.data[i], atlasImage.data[i + 1], atlasImage.data[i + 2]);
      }
    }
    glyphs.set(char, soften(gray, rect.w, rect.h, radius));
  }

  return {
    cellWidth: manifest.cellWidth,
    cellHeight: manifest.cellHeight,
    baselineFraction: manifest.baselineFraction,
    glyphs,
  };
}

/**
 * Normalized cross-correlation between two equal-length grayscale buffers, in [-1, 1].
 * Insensitive to uniform brightness/contrast offsets, which vary photo-to-photo and
 * cell-to-cell in a way a clean atlas render never does.
 */
export function normalizedCrossCorrelation(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error("normalizedCrossCorrelation requires equal-length buffers");
  }

  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }

  const denom = Math.sqrt(denomA * denomB);
  if (denom < 1e-6) return 0; // one or both buffers are flat/blank; no meaningful correlation

  return numerator / denom;
}

/** Difference between the darkest and brightest pixel in the middle of a cell. */
function centreContrast(cell: Float32Array, width: number, height: number): number {
  const inset = Math.floor((width * (1 - BLANK_REGION)) / 2);
  const from = Math.min(inset, Math.floor((width - 1) / 2));
  const to = width - from;

  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = from; x < to; x++) {
      const v = cell[y * width + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return max - min;
}

/**
 * Where across its own cell a glyph is looked for, as shares of the cell's width.
 *
 * A grid laid over a photograph puts each cell within a fraction of a cell of
 * where its glyph really is, not on it: the pitch is measured to a fraction of
 * a percent, but that fraction adds up along a line, and a lens and a screen
 * that is not quite flat move each stretch of a line a little further. A
 * template compared off-centre scores lower than a wrong template that happens
 * to share the offset, so a misplaced cell reads as the wrong character with
 * every sign of confidence. Looking a few places either side and keeping each
 * template's best finds the glyph where it is. Measured over the photos taken
 * against a screen profile, it takes the share of cells read wrong from about
 * half to about a quarter; searching less far gives some of that back.
 */
const SHIFTS = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3];

/**
 * What a match gives up per cell width it had to move, in correlation.
 *
 * Moved far enough, a cell takes in part of its neighbour, and a narrow
 * template can find a stroke of the neighbour's glyph there - on clean text,
 * where every cell is already in place, that is the only thing the search can
 * find. Charging for the move keeps a glyph where the grid put it unless it
 * fits clearly better elsewhere. Measured over the fixtures, this figure keeps
 * the renders within a point or two of reading with no search at all, where
 * without it some lost ten, and costs the photographs about one point of what
 * the search gains them.
 */
const SHIFT_COST = 0.4;

/**
 * The templates as the search compares them: at half size, which costs the
 * search nothing measurable in accuracy and a quarter of the work, and with
 * their mean taken out and scaled to unit length, so a correlation is one dot
 * product. A flat template - the space - has no shape to correlate with and is
 * left all zeros.
 */
interface SearchTemplates {
  width: number;
  height: number;
  glyphs: Array<[string, Float32Array]>;
}

const searchTemplates = new WeakMap<GlyphAtlas, SearchTemplates>();

function templatesFor(atlas: GlyphAtlas): SearchTemplates {
  let found = searchTemplates.get(atlas);
  if (!found) {
    const width = Math.max(1, Math.floor(atlas.cellWidth / 2));
    const height = Math.max(1, Math.floor(atlas.cellHeight / 2));
    const glyphs: Array<[string, Float32Array]> = [];
    for (const [char, glyph] of atlas.glyphs) {
      glyphs.push([char, unitize(halve(glyph, atlas.cellWidth, atlas.cellHeight, width, height))]);
    }
    found = { width, height, glyphs };
    searchTemplates.set(atlas, found);
  }
  return found;
}

/** Each pixel of the half-size image is the mean of the two-by-two block it covers. */
function halve(full: Float32Array, fullWidth: number, fullHeight: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const sx = fullWidth / width;
  const sy = fullHeight / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(fullHeight - 1, y0 + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(fullWidth - 1, x0 + 1);
      out[y * width + x] =
        (full[y0 * fullWidth + x0] +
          full[y0 * fullWidth + x1] +
          full[y1 * fullWidth + x0] +
          full[y1 * fullWidth + x1]) /
        4;
    }
  }
  return out;
}

/** Mean taken out and scaled to unit length, in place; a flat buffer comes back all zeros. */
function unitize(values: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i];
  mean /= values.length;
  let length = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] -= mean;
    length += values[i] * values[i];
  }
  length = Math.sqrt(length);
  const scale = length < 1e-6 ? 0 : 1 / length;
  for (let i = 0; i < values.length; i++) values[i] *= scale;
  return values;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Crops+resamples the given cell rect to the atlas's canonical size, then matches it against
 * every glyph via NCC (Stage 5), and applies the confidence-floor/ambiguity-margin flagging
 * rules (Stage 6) so a cell is never silently force-matched to a weak or ambiguous candidate.
 *
 * Each glyph is scored at its best place across the cell; see SHIFTS.
 */
export function matchCell(image: ImageData, cellRect: Rect, atlas: GlyphAtlas): MatchResult {
  const resampled = resampleToGray(image, cellRect, atlas.cellWidth, atlas.cellHeight);

  if (centreContrast(resampled, atlas.cellWidth, atlas.cellHeight) < BLANK_CONTRAST) {
    return { char: " ", confidence: 1, candidates: [{ char: " ", score: 1 }], flagged: false };
  }

  const templates = templatesFor(atlas);
  const raw = new Float32Array(templates.glyphs.length).fill(-1);
  for (const shift of SHIFTS) {
    const moved = { ...cellRect, x: cellRect.x + shift * cellRect.w };
    const sample = unitize(resampleToGray(image, moved, templates.width, templates.height));
    templates.glyphs.forEach(([, glyph], i) => {
      raw[i] = Math.max(raw[i], dot(sample, glyph) - SHIFT_COST * Math.abs(shift));
    });
  }

  const scores: MatchCandidate[] = templates.glyphs.map(([char], i) => ({ char, score: (raw[i] + 1) / 2 }));
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  const second = scores[1];

  const belowFloor = !best || best.score < CONFIDENCE_FLOOR;
  const tooAmbiguous = !!best && !!second && best.score - second.score < MARGIN_THRESHOLD;

  return {
    char: best ? best.char : "",
    confidence: best ? best.score : 0,
    candidates: scores.slice(0, CANDIDATE_LIMIT),
    flagged: belowFloor || tooAmbiguous,
  };
}
