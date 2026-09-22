import { describe, expect, it } from "vitest";
import { formatScreenProfile, parseScreenProfile } from "./settings";

describe("parseScreenProfile", () => {
  it("reads the pane's size alone, the way overlay.py prints it and the obvious variants", () => {
    const pane = { width: 985, height: 563 };
    expect(parseScreenProfile("985 x 563")).toEqual({ pane, grid: null });
    expect(parseScreenProfile("985x563")).toEqual({ pane, grid: null });
    expect(parseScreenProfile(" 985 × 563 ")).toEqual({ pane, grid: null });
    expect(parseScreenProfile("985, 563")).toEqual({ pane, grid: null });
    expect(parseScreenProfile("1897 X 1031")).toEqual({ pane: { width: 1897, height: 1031 }, grid: null });
  });

  it("reads the whole profile line, pasted or typed short", () => {
    const want = { pane: { width: 985, height: 563 }, grid: { advance: 10.75, lineHeight: 23, textLeft: 42 } };
    expect(parseScreenProfile("profile: 985 x 563, cell 10.750 x 23, text at 42")).toEqual(want);
    expect(parseScreenProfile("985 x 563, cell 10.75 x 23, text at 42")).toEqual(want);
    expect(parseScreenProfile("985x563 10.75x23 42")).toEqual(want);
    expect(parseScreenProfile("985, 563, 10.75, 23, 42")).toEqual(want);
  });

  it("refuses anything that is not two positive sizes, or a whole profile", () => {
    expect(parseScreenProfile("")).toBeNull();
    expect(parseScreenProfile("985")).toBeNull();
    expect(parseScreenProfile("0 x 563")).toBeNull();
    expect(parseScreenProfile("985 x -563")).toBeNull();
    expect(parseScreenProfile("wide x tall")).toBeNull();
    // Half a cell is not a cell.
    expect(parseScreenProfile("985 x 563, cell 10.75")).toBeNull();
    expect(parseScreenProfile("985 x 563, cell 10.75 x 23")).toBeNull();
  });

  // A typo in a profile that is then trusted is worse than no profile at all:
  // the grid would be laid out wrong on every capture.
  it("refuses a grid that cannot be an editor's", () => {
    expect(parseScreenProfile("985 x 563, cell 23 x 10.75, text at 42")).toBeNull();
    expect(parseScreenProfile("985 x 563, cell 10.75 x 230, text at 42")).toBeNull();
    expect(parseScreenProfile("985 x 563, cell 10.75 x 23, text at 600")).toBeNull();
    expect(parseScreenProfile("985 x 563, cell 0 x 23, text at 42")).toBeNull();
  });
});

describe("formatScreenProfile", () => {
  it("writes back what it reads", () => {
    for (const text of ["985 x 563", "985 x 563, cell 10.75 x 23, text at 42"]) {
      expect(formatScreenProfile(parseScreenProfile(text)!)).toBe(text);
    }
  });
});
