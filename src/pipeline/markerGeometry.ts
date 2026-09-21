import geometry from "../../tools/marker-geometry.json";

/**
 * The shape of a corner marker, as one definition.
 *
 * The overlay draws these and the detector looks for them, so a disagreement
 * between the two is a disagreement about where the pane is. The numbers live
 * in tools/marker-geometry.json, which the overlay's own constants are checked
 * against; the reasoning is in tools/README.md.
 */

/** Length of each arm of the L, in pixels at 100% display scaling. */
export const ARM = geometry.armPx;

/** Thickness of each arm. */
export const THICK = geometry.thickPx;

/** White border around the L on the sides facing the window chrome. */
export const MARGIN = geometry.marginPx;

/**
 * Share of the L's square bounding box that is ink.
 *
 * Two arms of ARM by THICK overlapping in a THICK square at the corner. The
 * detector uses it to tell a marker from every other dark thing in a
 * photograph: it is a ratio, so it holds at any distance from the screen.
 */
export const FILL_RATIO = (2 * ARM * THICK - THICK * THICK) / (ARM * ARM);

export type Corner = "tl" | "tr" | "br" | "bl";

export const CORNERS: Corner[] = ["tl", "tr", "br", "bl"];

/**
 * Which corner of the pane a marker names, from which quadrant of it is empty.
 *
 * An L covers two edges of its bounding box that meet at one corner, so the
 * quadrant diagonally opposite that corner has no ink in it. The corner where
 * its two outer edges meet is the pane corner - and since that is the corner
 * furthest from the empty quadrant, the shape alone says which corner of the
 * pane the marker belongs to, however the shot is rotated.
 *
 * The top markers sit above the pane and the bottom markers below it, so a
 * marker whose pane corner is the pane's top-left has ink along its own bottom
 * and left edges, and its empty quadrant is the top-right.
 */
export const CORNER_BY_EMPTY_QUADRANT: Record<Corner, Corner> = {
  tr: "tl",
  tl: "tr",
  br: "bl",
  bl: "br",
};
