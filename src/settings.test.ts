import { describe, expect, it } from "vitest";
import { parsePaneSize } from "./settings";

describe("parsePaneSize", () => {
  it("reads the size the way overlay.py prints it, and the obvious variants", () => {
    expect(parsePaneSize("985 x 563")).toEqual({ width: 985, height: 563 });
    expect(parsePaneSize("985x563")).toEqual({ width: 985, height: 563 });
    expect(parsePaneSize(" 985 × 563 ")).toEqual({ width: 985, height: 563 });
    expect(parsePaneSize("985, 563")).toEqual({ width: 985, height: 563 });
    expect(parsePaneSize("1897 X 1031")).toEqual({ width: 1897, height: 1031 });
  });

  it("refuses anything that is not two positive sizes", () => {
    expect(parsePaneSize("")).toBeNull();
    expect(parsePaneSize("985")).toBeNull();
    expect(parsePaneSize("0 x 563")).toBeNull();
    expect(parsePaneSize("985 x -563")).toBeNull();
    expect(parsePaneSize("wide x tall")).toBeNull();
  });
});
