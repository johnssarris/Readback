import { describe, expect, it } from "vitest";
import { visibleLines } from "./harness/cases";

describe("visibleLines", () => {
  const text = "one\ntwo\nthree\nfour\nfive\n";

  it("takes the file from the top when the sidecar does not say where the screen was", () => {
    expect(visibleLines(text, {})).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("takes the lines the overlay's label named, counting from 1", () => {
    expect(visibleLines(text, { lines: [2, 4] })).toEqual(["two", "three", "four"]);
  });

  it("refuses a range that cannot be one", () => {
    expect(() => visibleLines(text, { lines: [0, 3] })).toThrow();
    expect(() => visibleLines(text, { lines: [4, 2] })).toThrow();
  });
});
