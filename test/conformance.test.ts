import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/index";
import { canonical, parse } from "../src/index";
import { loadCases } from "./cases.ts";
import { loadExpectedFailures } from "./expected.ts";
import { reconstruct } from "./lossless.ts";
import { memberOrder, toTaggedDocument } from "./tagged.ts";

const { valid, invalid } = loadCases();
const expectedFailures = loadExpectedFailures();

// A case on the list must fail; any other case must pass. See expected-failures.txt.
function register(id: string, body: () => void): void {
  if (expectedFailures.has(id)) {
    it.fails(
      `${id} [expected failure: remove it from expected-failures.txt when this passes]`,
      body,
    );
  } else {
    it(id, body);
  }
}

function describeDiagnostics(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return "no diagnostics";
  }
  return diagnostics
    .map((d) => `${d.code} ${d.start.line}:${d.start.column} ${d.message}`)
    .join("; ");
}

describe("valid documents", () => {
  for (const c of valid) {
    register(c.id, () => {
      const result = parse(c.input);
      expect(result.ok, describeDiagnostics(result.diagnostics)).toBe(true);

      expect(canonical(result.tree)).toBe(c.canonical);

      const actual = toTaggedDocument(result);
      expect(actual).toEqual(c.value);
      expect(memberOrder(actual)).toEqual(memberOrder(c.value));

      expect(reconstruct(result.tree)).toBe(result.tree.text);

      const again = parse(c.canonical);
      expect(again.ok, "the canonical form must itself parse").toBe(true);
      expect(canonical(again.tree), "canonical form must be idempotent").toBe(c.canonical);
    });
  }
});

describe("invalid documents", () => {
  for (const c of invalid) {
    register(c.id, () => {
      const result = parse(c.input);
      expect(result.ok, "the document must be rejected").toBe(false);
      for (const want of c.diagnostics) {
        const found = result.diagnostics.some(
          (d) =>
            d.code === want.code &&
            (want.at === undefined ||
              (d.start.line === want.at.line && d.start.column === want.at.column)),
        );
        const where = want.at === undefined ? "anywhere" : `at ${want.at.line}:${want.at.column}`;
        expect(
          found,
          `expected ${want.code} ${where}; got ${describeDiagnostics(result.diagnostics)}`,
        ).toBe(true);
      }
    });
  }
});
