import { describe, expect, it } from "vitest";
import { LIMIT_MINIMUMS, resolveLimits } from "../src/limits";

describe("LIMIT_MINIMUMS", () => {
  it("are the minimums in specification 3.4", () => {
    expect(LIMIT_MINIMUMS).toEqual({
      documentBytes: 2147483647,
      depth: 256,
      tokenBytes: 2147483647,
      runLength: 64,
      elements: 2147483647,
    });
  });

  it("cannot be changed", () => {
    expect(Object.isFrozen(LIMIT_MINIMUMS)).toBe(true);
  });
});

describe("resolveLimits", () => {
  it("defaults to the minimums", () => {
    expect(resolveLimits()).toEqual(LIMIT_MINIMUMS);
    expect(resolveLimits({})).toEqual(LIMIT_MINIMUMS);
  });

  it("accepts values above the minimum", () => {
    expect(resolveLimits({ depth: 1000, runLength: 128 })).toEqual({
      ...LIMIT_MINIMUMS,
      depth: 1000,
      runLength: 128,
    });
    expect(resolveLimits({ elements: Number.POSITIVE_INFINITY }).elements).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("raises a value below the minimum to the minimum", () => {
    expect(resolveLimits({ depth: 10, runLength: 1, documentBytes: 0 })).toEqual(LIMIT_MINIMUMS);
  });

  it("treats a value that is not a usable number as unset", () => {
    const hostile = { depth: Number.NaN, runLength: "9999", tokenBytes: null } as unknown;
    expect(resolveLimits(hostile as Partial<typeof LIMIT_MINIMUMS>)).toEqual(LIMIT_MINIMUMS);
  });

  it("returns a frozen object and does not change what it was given", () => {
    const supplied = { depth: 500 };
    const resolved = resolveLimits(supplied);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(supplied).toEqual({ depth: 500 });
    expect(LIMIT_MINIMUMS.depth).toBe(256);
  });
});
