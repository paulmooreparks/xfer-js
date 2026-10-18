import { describe, expect, it } from "vitest";
import { ORIGIN, positionAt } from "../src/position";

describe("positionAt", () => {
  it("starts at offset 0, line 1, column 1", () => {
    expect(positionAt("abc", 0)).toEqual(ORIGIN);
    expect(positionAt("", 0)).toEqual(ORIGIN);
  });

  it("counts columns in scalar values and offsets in UTF-8 bytes", () => {
    expect(positionAt("abc", 2)).toEqual({ offset: 2, line: 1, column: 3 });
    expect(positionAt("é日😀x", 4)).toEqual({ offset: 9, line: 1, column: 4 });
    expect(positionAt("é日😀x", 5)).toEqual({ offset: 10, line: 1, column: 5 });
  });

  it("starts a new line after each line feed and resets the column", () => {
    expect(positionAt("a\nbc\n\nd", 3)).toEqual({ offset: 3, line: 2, column: 2 });
    expect(positionAt("a\nbc\n\nd", 6)).toEqual({ offset: 6, line: 4, column: 1 });
    expect(positionAt("a\nbc\n\nd", 7)).toEqual({ offset: 7, line: 4, column: 2 });
  });

  it("counts a line feed as one byte in the line it ends", () => {
    expect(positionAt("é\nx", 2)).toEqual({ offset: 3, line: 2, column: 1 });
  });

  it("does not treat Unicode line separators as line ends", () => {
    expect(positionAt("a b", 3)).toEqual({ offset: 5, line: 1, column: 4 });
  });

  it("gives the position of the end for an index past the end", () => {
    expect(positionAt("a", 5)).toEqual({ offset: 1, line: 1, column: 2 });
    expect(positionAt("", 3)).toEqual(ORIGIN);
  });

  it("gives the position of a surrogate pair, not after it, for an index inside the pair", () => {
    expect(positionAt("😀x", 1)).toEqual(ORIGIN);
    expect(positionAt("a😀x", 2)).toEqual({ offset: 1, line: 1, column: 2 });
    expect(positionAt("a😀x", 3)).toEqual({ offset: 5, line: 1, column: 3 });
  });

  it("freezes the origin", () => {
    expect(Object.isFrozen(ORIGIN)).toBe(true);
  });
});
