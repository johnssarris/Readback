import { describe, expect, it } from "vitest";
import { visibleLines, wrapRows } from "./harness/cases";

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

describe("wrapRows", () => {
  it("breaks a long line after the last space that fits, and numbers only its first row", () => {
    expect(wrapRows(["short", "one two three", "x"], 9, 7)).toEqual({
      rows: ["short", "one two ", "three", "x"],
      rowNumbers: [7, 8, null, 9],
    });
  });

  it("breaks a word longer than the pane at the last column", () => {
    expect(wrapRows(["abcdefghij"], 4, 1).rows).toEqual(["abcd", "efgh", "ij"]);
  });

  // The laptop pane holds 69 columns of screen-test.txt; its second line is 70.
  it("wraps the test text's second line where the editor did", () => {
    const line = `0O o 1lI| rn m cl d vv w nn . , ; : ' " \` ~ - _ ^ 5S 2Z 8B 6G 9g qg uv`;
    expect(wrapRows([line], 69, 2).rows[1]).toBe("uv");
  });
});
