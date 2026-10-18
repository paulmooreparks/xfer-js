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
 * Applies caller-supplied limits over the defaults. The minimums bind the default configuration
 * (specification 3.4), so a caller may lower a limit as well as raise it. A value that is not a
 * positive number (NaN, zero, negative, or not a number at all) is ignored and the default stays.
 */
export function resolveLimits(supplied?: Partial<Limits>): Limits {
  const resolved = { ...LIMIT_MINIMUMS };
  if (supplied === undefined) {
    return Object.freeze(resolved);
  }
  for (const key of Object.keys(LIMIT_MINIMUMS) as (keyof Limits)[]) {
    const value = supplied[key];
    if (typeof value === "number" && value > 0) {
      resolved[key] = value;
    }
  }
  return Object.freeze(resolved);
}
