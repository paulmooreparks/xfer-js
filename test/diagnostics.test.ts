import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIAGNOSTICS, makeDiagnostic } from "../src/diagnostics";
import { loadCases } from "./cases.ts";

const SPEC = fileURLToPath(new URL("../suite/spec/xferlang.md", import.meta.url));

interface Row {
  readonly code: string;
  readonly severity: string;
  readonly summary: string;
}

/** The rows of the diagnostic-code table in specification section 10. */
function specRows(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(SPEC, "utf8").split("\n")) {
    const m = /^\| (XFER\d{4}) \| (\w+) \| (.*) \|$/.exec(line);
    if (m) {
      rows.push({
        code: m[1] as string,
        severity: m[2] as string,
        summary: (m[3] as string).trim(),
      });
    }
  }
  return rows;
}

describe("DIAGNOSTICS", () => {
  it("is the specification's table, row for row", () => {
    const fromSpec = specRows().map((r) => ({
      code: r.code,
      severity: r.severity === "informational" ? "info" : r.severity,
      summary: r.summary,
    }));
    const fromCode = Object.entries(DIAGNOSTICS).map(([code, info]) => ({
      code,
      severity: info.severity,
      summary: info.summary,
    }));
    expect(fromSpec.length).toBeGreaterThan(30);
    expect(fromCode).toEqual(fromSpec);
  });

  it("covers every code the suite requires", () => {
    const known = new Set(Object.keys(DIAGNOSTICS));
    const missing = new Set<string>();
    for (const c of loadCases().invalid) {
      for (const d of c.diagnostics) {
        if (!known.has(d.code)) {
          missing.add(d.code);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe("makeDiagnostic", () => {
  const start = { offset: 4, line: 2, column: 3 };
  const end = { offset: 6, line: 2, column: 5 };

  it("takes the severity and message from the table", () => {
    expect(makeDiagnostic("XFER0403", start, end)).toEqual({
      code: "XFER0403",
      severity: "error",
      message: "duplicate key",
      start,
      end,
    });
    expect(makeDiagnostic("XFER0901", start).severity).toBe("warning");
    expect(makeDiagnostic("XFER0903", start).severity).toBe("info");
  });

  it("makes a point diagnostic when no end is given", () => {
    const d = makeDiagnostic("XFER0701", start);
    expect(d.end).toBe(d.start);
  });

  it("appends specifics to the summary", () => {
    expect(makeDiagnostic("XFER0101", start, start, "found `-`").message).toBe(
      "scalar token not followed by a separator: found `-`",
    );
  });
});
