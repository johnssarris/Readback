/**
 * The editor pane's size on screen, when it is known.
 *
 * overlay.py prints it every time the pane moves ("pane: ... (985 x 563)").
 * Given here, it is the pane's proportions exactly, and the size a rectified
 * capture is laid out at, so every capture of the same pane has the same
 * character cells. Without it both are worked out from the photograph.
 *
 * Kept in this browser only. Storage can be missing or refuse (a private
 * window, cleared site data), and the app works the same without it.
 */
export interface PaneSize {
  width: number;
  height: number;
}

const KEY = "readback.paneSize";

export function loadPaneSize(): PaneSize | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parsePaneSize(raw) : null;
  } catch {
    return null;
  }
}

export function savePaneSize(size: PaneSize | null): void {
  try {
    if (size) localStorage.setItem(KEY, `${size.width} x ${size.height}`);
    else localStorage.removeItem(KEY);
  } catch {
    // Nowhere to keep it; the photograph will have to say.
  }
}

/** "985 x 563", "985x563", "985 × 563" or "985, 563"; null for anything else. */
export function parsePaneSize(text: string): PaneSize | null {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*[x×,]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}
