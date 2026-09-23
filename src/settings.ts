import type { GridProfile } from "./pipeline/profileGrid";

/**
 * The editor pane's size on screen and, when it could be read, the grid of
 * character cells in it: what overlay.py prints as its profile line.
 *
 *   profile: 985 x 563, cell 10.750 x 23, text at 42
 *
 * Given here, the size is the pane's proportions exactly, and the size a
 * rectified capture is laid out at, so every capture of the same pane has the
 * same character cells. The cell is the advance and line height, and "text at"
 * is where the first column starts, all in screen pixels from the pane's top
 * left; with them the grid is laid out rather than searched for. Either half
 * can be missing - the size alone is still worth giving, and without either,
 * both are worked out from the photograph.
 *
 * Kept in this browser only. Storage can be missing or refuse (a private
 * window, cleared site data), and the app works the same without it.
 */
export interface PaneSize {
  width: number;
  height: number;
}

export interface ScreenProfile {
  pane: PaneSize;
  /** Null when only the pane's size was given. */
  grid: GridProfile | null;
}

const KEY = "readback.paneSize";

export function loadScreenProfile(): ScreenProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseScreenProfile(raw) : null;
  } catch {
    return null;
  }
}

export function saveScreenProfile(profile: ScreenProfile | null): void {
  try {
    if (profile) localStorage.setItem(KEY, formatScreenProfile(profile));
    else localStorage.removeItem(KEY);
  } catch {
    // Nowhere to keep it; the photograph will have to say.
  }
}

/** The pane's size alone, for what needs only that. */
export function loadPaneSize(): PaneSize | null {
  return loadScreenProfile()?.pane ?? null;
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const BY = String.raw`\s*[x×,]\s*`;
const PROFILE = new RegExp(
  String.raw`^(?:profile:\s*)?${NUMBER}${BY}${NUMBER}` +
    String.raw`(?:\s*,?\s*(?:cell\s*)?${NUMBER}${BY}${NUMBER}\s*,?\s*(?:text(?:\s+at)?\s*)?${NUMBER})?$`,
  "i"
);

/**
 * The profile line as overlay.py prints it, or as typed from it: "985 x 563",
 * or "985 x 563, cell 10.75 x 23, text at 42", with the words optional ("985 x
 * 563 10.75 x 23 42") and a comma as good as an x. Null for anything else, or
 * for numbers that cannot describe an editor pane: a cell wider than it is
 * tall, taller than a quarter of the pane, or text starting past its middle.
 */
export function parseScreenProfile(text: string): ScreenProfile | null {
  const match = text.trim().match(PROFILE);
  if (!match) return null;

  const [width, height, advance, lineHeight, textLeft] = match.slice(1).map((m) => (m === undefined ? NaN : Number(m)));
  if (!(width > 0 && height > 0)) return null;
  const pane = { width, height };
  if (match[3] === undefined) return { pane, grid: null };

  const grid = { advance, lineHeight, textLeft };
  return plausibleGrid(grid, pane) ? { pane, grid } : null;
}

function plausibleGrid(grid: GridProfile, pane: PaneSize): boolean {
  return (
    grid.advance > 0 &&
    grid.lineHeight > grid.advance &&
    grid.lineHeight <= pane.height / 4 &&
    grid.textLeft >= 0 &&
    grid.textLeft < pane.width / 2
  );
}

/** Back into the form it is typed in, so what is shown is what will be used. */
export function formatScreenProfile({ pane, grid }: ScreenProfile): string {
  const size = `${pane.width} x ${pane.height}`;
  return grid ? `${size}, cell ${grid.advance} x ${grid.lineHeight}, text at ${grid.textLeft}` : size;
}

/**
 * The test text open in the editor, by its name under tests/fixtures, so a
 * saved capture says what was on screen instead of leaving it to be read off
 * the photograph afterwards. Null when it was something else.
 */
export const TEST_TEXTS = ["screen-test.txt", "sample-varied.txt"] as const;
export type TestText = (typeof TEST_TEXTS)[number];

const TEST_TEXT_KEY = "readback.testText";

export function loadTestText(): TestText | null {
  try {
    const raw = localStorage.getItem(TEST_TEXT_KEY);
    return TEST_TEXTS.find((t) => t === raw) ?? null;
  } catch {
    return null;
  }
}

export function saveTestText(text: TestText | null): void {
  try {
    if (text) localStorage.setItem(TEST_TEXT_KEY, text);
    else localStorage.removeItem(TEST_TEXT_KEY);
  } catch {
    // Nowhere to keep it; saved captures will ask for their text instead.
  }
}
