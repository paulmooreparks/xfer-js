import type { Limits } from "./types";

/** The minimums every conformant parser must accept (specification 3.4), and the defaults. */
export const LIMIT_MINIMUMS: Limits = Object.freeze({
  documentBytes: 2 ** 28 - 1,
  depth: 256,
  tokenBytes: 2 ** 28 - 1,
  runLength: 64,
  elements: 2 ** 31 - 1,
});

/**
 * Applies caller-supplied limits over the defaults. A value below the specification's minimum, or
 * one that is not a number, is replaced by the minimum: a parser may accept more than the minimum
 * but never less.
 */
export function resolveLimits(supplied?: Partial<Limits>): Limits {
  const resolved = { ...LIMIT_MINIMUMS };
  if (supplied === undefined) {
    return Object.freeze(resolved);
  }
  for (const key of Object.keys(LIMIT_MINIMUMS) as (keyof Limits)[]) {
    const value = supplied[key];
    if (typeof value === "number" && value >= LIMIT_MINIMUMS[key]) {
      resolved[key] = value;
    }
  }
  return Object.freeze(resolved);
}
