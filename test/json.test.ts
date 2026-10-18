import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { XferValue } from "../src/index";
import {
  asDecimal,
  asNumber,
  canonical,
  fromJson,
  parse,
  parseValue,
  toJson,
  toPlain,
} from "../src/index";
import { loadCases } from "./cases.ts";
import { loadFromJsonCases, loadToJsonCases } from "./json-cases.ts";

describe("toJson conformance", () => {
  for (const c of loadToJsonCases()) {
    it(c.id, () => {
      const value = parseValue(c.xfer);
      const { text, diagnostics } = toJson(value, { stringifyBigInts: c.stringifyBigInts });
      expect(text).toBe(c.json);
      const codes = new Set<string>(diagnostics.map((d) => d.code));
      for (const want of c.codes) {
        expect(codes.has(want), `missing ${want}`).toBe(true);
      }
      expect(() => JSON.parse(text)).not.toThrow();
    });
  }
});

describe("fromJson conformance", () => {
  for (const c of loadFromJsonCases()) {
    it(c.id, () => {
      const { value, diagnostics } = fromJson(c.json);
      const codes = new Set<string>(diagnostics.map((d) => d.code));
      for (const want of c.codes) {
        expect(codes.has(want), `missing ${want}`).toBe(true);
      }
      if (c.xfer === undefined) {
        expect(value).toBeUndefined();
        expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
      } else {
        expect(value).toBeDefined();
        expect(canonical(value as XferValue)).toBe(c.xfer);
      }
    });
  }
});

describe("toJson", () => {
  it("indents when asked, as JSON.stringify does", () => {
    const value = parseValue("{ a [ 1 2 ] b { } c [ ] d { e null } }");
    const { text } = toJson(value, { indent: 2 });
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });

  it("reports a pointer and a count, not a diagnostic per value", () => {
    const value = parseValue("[ a b c 2025-01-01 ]");
    const { diagnostics } = toJson(value);
    expect(diagnostics.map((d) => d.code)).toEqual(["XFER0903", "XFER0904"]);
    expect(diagnostics[0]?.message).toContain("3 symbols, first at /0");
  });

  it("escapes pointer tokens", () => {
    const value = parseValue('{ "a/b~c" inf }');
    expect(toJson(value).diagnostics[0]?.message).toContain("/a~1b~0c");
  });

  it("writes deep nesting without recursion", () => {
    const depth = 200_000;
    let value: XferValue = { kind: "null" };
    for (let i = 0; i < depth; i++) {
      value = { kind: "sequence", items: [value] };
    }
    const { text } = toJson(value);
    expect(text.length).toBe(depth * 2 + 4);
  });

  it("rejects a value of an unknown kind", () => {
    expect(() => toJson({ kind: "nope" } as unknown as XferValue)).toThrow(TypeError);
  });
});

describe("fromJson", () => {
  it("never throws and always gives a value or an error", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const { value, diagnostics } = fromJson(text);
        const failed = diagnostics.some((d) => d.severity === "error");
        expect(value === undefined).toBe(failed);
      }),
      { numRuns: 5000 },
    );
  });

  it("agrees with JSON.parse on what is well formed", () => {
    const punctuation = fc.string({
      unit: fc.constantFrom("[", "]", "{", "}", ",", ":", '"', "1", "-", ".", "e", "t", " "),
    });
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc.jsonValue().map((v) => JSON.stringify(v, null, 2)),
          fc.string(),
          punctuation,
        ),
        (text) => {
          let valid = true;
          try {
            JSON.parse(text);
          } catch {
            valid = false;
          }
          const malformed = fromJson(text).diagnostics.some((d) => d.code === "XFER0906");
          expect(malformed, text).toBe(!valid);
        },
      ),
      { numRuns: 20000 },
    );
  });

  it("round-trips JSON values through XferLang", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const text = JSON.stringify(v);
        const read = fromJson(text);
        if (read.value === undefined) {
          // Only the characters XferLang cannot hold may stop a conversion.
          expect(read.diagnostics.every((d) => d.code === "XFER0907")).toBe(true);
          return;
        }
        const back = toJson(parseValue(canonical(read.value))).text;
        expect(JSON.parse(back)).toEqual(JSON.parse(text));
      }),
      { numRuns: 5000 },
    );
  });

  it("keeps __proto__ as data", () => {
    const { value } = fromJson('{"__proto__":{"x":1}}');
    const plain = toPlain(value as XferValue) as Record<string, unknown>;
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(Object.keys(plain)).toEqual(["__proto__"]);
  });

  it("reads deep nesting without recursion", () => {
    const depth = 200_000;
    const { value, diagnostics } = fromJson("[".repeat(depth) + "]".repeat(depth));
    expect(diagnostics).toEqual([]);
    expect(value?.kind).toBe("sequence");
  });

  it("positions a fault in the JSON text", () => {
    const { diagnostics } = fromJson('{\n  "a": 1,\n  "b": ?\n}');
    expect(diagnostics[0]?.code).toBe("XFER0906");
    expect(diagnostics[0]?.start).toMatchObject({ line: 3, column: 8 });
  });

  it("reports every unrepresentable string, not only the first", () => {
    const { diagnostics } = fromJson('["\\r","ok","\\ud800"]');
    expect(diagnostics.filter((d) => d.code === "XFER0907")).toHaveLength(2);
  });

  it("rejects a raw lone surrogate in the input", () => {
    const { value, diagnostics } = fromJson('["\ud800"]');
    expect(value).toBeUndefined();
    expect(diagnostics[0]?.code).toBe("XFER0907");
  });
});

describe("every valid suite document", () => {
  it("survives JSON when read back as plain data", () => {
    const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    for (const c of loadCases().valid) {
      const value = parse(c.input).value as XferValue;
      const { text, diagnostics } = toJson(value);
      if (diagnostics.some((d) => d.severity === "error")) {
        continue; // inf, -inf and nan have no JSON form
      }
      const back = fromJson(text).value;
      expect(back, c.id).toBeDefined();
      const want = toPlain(value, { integers: "bigint" });
      const got = toPlain(back as XferValue, { integers: "bigint" });
      expect(JSON.stringify(got, replacer), c.id).toBe(JSON.stringify(want, replacer));
    }
  });
});

describe("toPlain", () => {
  it("projects every kind", () => {
    const v = parseValue(
      "{ i 42 big 9007199254740993 f 1.5 g inf s dark t 2025-08-01 b true n null str x l [ 1 { } ] }",
    );
    expect(toPlain(v)).toEqual({
      i: 42,
      big: 9007199254740993n,
      f: 1.5,
      g: Number.POSITIVE_INFINITY,
      s: "dark",
      t: "2025-08-01",
      b: true,
      n: null,
      str: "x",
      l: [1, {}],
    });
  });

  it("can keep every integer a bigint and every symbol a symbol", () => {
    const v = parseValue("[ 1 sym ]");
    expect(toPlain(v, { integers: "bigint", symbols: "symbol-object" })).toEqual([
      1n,
      { kind: "symbol", name: "sym" },
    ]);
  });

  it("projects deep nesting without recursion", () => {
    let value: XferValue = { kind: "null" };
    for (let i = 0; i < 200_000; i++) {
      value = { kind: "sequence", items: [value] };
    }
    expect(Array.isArray(toPlain(value))).toBe(true);
  });
});

describe("asDecimal and asNumber", () => {
  const frac = (lexeme: string) => ({ kind: "fractional", lexeme }) as const;

  it("splits a lexeme into digits and a power of ten", () => {
    expect(asDecimal(frac("1.50"))).toEqual({ digits: 150n, exponent: -2 });
    expect(asDecimal(frac("6.02e23"))).toEqual({ digits: 602n, exponent: 21 });
    expect(asDecimal(frac("-1_0.5E-1"))).toEqual({ digits: -105n, exponent: -2 });
    expect(asDecimal(frac("inf"))).toBeUndefined();
    expect(asDecimal(frac("nan"))).toBeUndefined();
  });

  it("says whether a number is exact", () => {
    expect(asNumber(frac("0.5"))).toEqual({ value: 0.5, exact: true });
    expect(asNumber(frac("0.1")).exact).toBe(false);
    expect(asNumber(frac("1e400")).exact).toBe(false);
    expect(asNumber(frac("1e-400")).exact).toBe(false);
    expect(asNumber(frac("0.0e5"))).toEqual({ value: 0, exact: true });
    expect(asNumber(frac("inf"))).toEqual({ value: Number.POSITIVE_INFINITY, exact: true });
    const int = (value: bigint) => ({ kind: "integer", value, lexeme: String(value) }) as const;
    expect(asNumber(int(2n ** 53n)).exact).toBe(true);
    expect(asNumber(int(2n ** 53n + 1n)).exact).toBe(false);
    expect(asNumber(int(10n ** 400n)).exact).toBe(false);
  });

  it("is exact for the full decimal expansion of any double, and not for a neighbour", () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true, min: 1e-300, max: 1e300 }),
        (d) => {
          const bits = new DataView(new ArrayBuffer(8));
          bits.setFloat64(0, d);
          const raw = bits.getBigUint64(0);
          const biased = Number((raw >> 52n) & 0x7ffn);
          const mantissa = (raw & ((1n << 52n) - 1n)) | (biased === 0 ? 0n : 1n << 52n);
          const x = (biased === 0 ? 1 : biased) - 1075;
          const digits = x < 0 ? mantissa * 5n ** BigInt(-x) : mantissa * 2n ** BigInt(x);
          const lexeme = `${digits}e${Math.min(x, 0)}`;
          expect(asNumber(frac(lexeme))).toEqual({ value: d, exact: true });
          expect(asNumber(frac(`${digits * 10n + 1n}e${Math.min(x, 0) - 1}`)).exact).toBe(false);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
