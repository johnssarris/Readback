import { describe, expect, it } from "vitest";
import { errorBreakdown } from "./harness/metrics";

/** A recognized row, from the text it came back as: a space is a cell read as blank. */
const row = (text: string) => ({ cells: [...text].map((c) => ({ char: c === " " ? "" : c })) });

describe("errorBreakdown", () => {
  it("counts wrong cells by where they are and what they should have been", () => {
    const truth = ["ab1 ;x", "      ", "cd2 .y"];
    const read = [row("ab1 ;x"), row("  q   "), row("cz  .y")];
    const out = errorBreakdown(read, truth);

    // Six columns make thirds of two. Row 3's d is misread (a letter, in the
    // left third) and its 2 read as blank (a digit, in the middle third); in
    // row 2 a blank is read as q.
    expect(out.byClass.letter).toEqual([1, 6]);
    expect(out.byClass.digit).toEqual([1, 2]);
    expect(out.byClass.punct).toEqual([0, 2]);
    expect(out.byClass.blank).toEqual([1, 8]);
    expect(out.across).toEqual([
      [1, 4],
      [1, 2],
      [0, 4],
    ]);
    expect(out.down).toEqual([
      [0, 5],
      [0, 0],
      [2, 5],
    ]);
    expect(out.inkToBlank).toEqual([1, 10]);
    expect(out.blankToInk).toEqual([1, 8]);
  });
});
