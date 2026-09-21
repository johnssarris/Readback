import { describe, expect, it } from "vitest";
import { fitNumbering } from "./lineNumbers";

const read = (value: number) => ({ value, confidence: 0.9 });

describe("fitNumbering", () => {
  it("repairs a misread number from the ones around it", () => {
    // 8 read as 3. Every other row agrees the first was 5, so this one is 8.
    const rows = fitNumbering([read(5), read(6), read(7), read(3), read(9)]);

    expect(rows.map((r) => r.value)).toEqual([5, 6, 7, 8, 9]);
    expect(rows[3].confidence).toBeLessThan(rows[2].confidence);
  });

  it("counts only numbered rows, so wrapped rows do not shift the numbering", () => {
    // A wrapped continuation sits between lines 2 and 3 and has no number of
    // its own; the line after it is still the next line.
    const rows = fitNumbering([read(2), null, read(3), read(4)]);

    expect(rows.map((r) => r.value)).toEqual([2, NaN, 3, 4]);
    expect(rows.map((r) => r.hasNumber)).toEqual([true, false, true, true]);
  });

  it("keeps a lone reading when there is nothing to vote against", () => {
    const rows = fitNumbering([read(17)]);
    expect(rows[0].value).toBe(17);
  });

  it("reports nothing for a screenful with no numbers at all", () => {
    const rows = fitNumbering([null, null]);
    expect(rows.every((r) => !r.hasNumber && Number.isNaN(r.value))).toBe(true);
  });
});
