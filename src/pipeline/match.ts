import { luminance, resampleToGray, type Rect } from "./imageUtils";

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

/** Builds a runtime glyph atlas (grayscale bitmaps) from the generated sprite sheet + manifest. */
export function buildAtlasFromImageData(atlasImage: ImageData, manifest: AtlasManifest): GlyphAtlas {
  const glyphs = new Map<string, Float32Array>();

  for (const [char, rect] of Object.entries(manifest.sprites)) {
    const gray = new Float32Array(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const i = ((rect.y + y) * atlasImage.width + (rect.x + x)) * 4;
        gray[y * rect.w + x] = luminance(atlasImage.data[i], atlasImage.data[i + 1], atlasImage.data[i + 2]);
      }
    }
    glyphs.set(char, gray);
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
 * Crops+resamples the given cell rect to the atlas's canonical size, then matches it against
 * every glyph via NCC (Stage 5), and applies the confidence-floor/ambiguity-margin flagging
 * rules (Stage 6) so a cell is never silently force-matched to a weak or ambiguous candidate.
 */
export function matchCell(image: ImageData, cellRect: Rect, atlas: GlyphAtlas): MatchResult {
  const resampled = resampleToGray(image, cellRect, atlas.cellWidth, atlas.cellHeight);

  if (centreContrast(resampled, atlas.cellWidth, atlas.cellHeight) < BLANK_CONTRAST) {
    return { char: " ", confidence: 1, candidates: [{ char: " ", score: 1 }], flagged: false };
  }

  const scores: MatchCandidate[] = [];
  for (const [char, glyph] of atlas.glyphs) {
    const raw = normalizedCrossCorrelation(resampled, glyph);
    scores.push({ char, score: (raw + 1) / 2 });
  }
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
