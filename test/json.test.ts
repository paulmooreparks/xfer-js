import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { XferValue } from "../src/index";
import {
  asDecimal,
  asNumber,
  asTemporal,
  canonical,
  fromJson,
  parse,
  parseValue,
  toJson,
  toPlain,
} from "../src/index";
import { loadCases } from "./cases.ts";
import { loadFromJsonCases, loadToJsonCases } from "./json-cases.ts";

/** The text of a conversion that must not have been refused for length. */
function defined(text: string | undefined): string {
  expect(text).toBeDefined();
  return text as string;
}

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
      expect(() => JSON.parse(defined(text))).not.toThrow();
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
    expect(text).toBe(JSON.stringify(JSON.parse(defined(text)), null, 2));
  });

  it("reports a pointer and a count, not a diagnostic per value", () => {
    const value = parseValue("[ a b c 2025-01-01 ]");
    const { diagnostics } = toJson(value);
    expect(diagnostics.map((d) => d.code)).toEqual(["XFER0903", "XFER0904"]);
    expect(diagnostics[0]?.message).toContain("3 symbols, first at /0");
  });

  it("refuses text longer than the document size limit, with XFER0601 and no text", () => {
    const value = parseValue("[ 1 2 3 ]");
    expect(toJson(value, { limits: { documentBytes: 7 } }).text).toBe("[1,2,3]");
    const refused = toJson(value, { limits: { documentBytes: 6 } });
    expect(refused.text).toBeUndefined();
    expect(refused.diagnostics.map((d) => d.code)).toEqual(["XFER0601"]);
    expect(refused.diagnostics[0]?.message).toContain("longer than 6 characters");
  });

  it("refuses indented text that grows past the limit long before a string would fail", () => {
    // 250 levels of indentation around a million items: about 550 million characters indented.
    const deep = `${"[".repeat(250)}${"1 ".repeat(1_000_000)}${"]".repeat(250)}`;
    const value = parseValue(deep);
    const result = toJson(value, { indent: 2 });
    expect(result.text).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual(["XFER0601"]);
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
    expect(defined(text).length).toBe(depth * 2 + 4);
  });

  it("writes exactly the diagnostics the value calls for", () => {
    const codes = (xfer: string) => toJson(parseValue(xfer)).diagnostics.map((d) => d.code);
    expect(codes("[ 9007199254740992 -9007199254740992 ]")).toEqual([]);
    expect(codes("[ 9007199254740993 ]")).toEqual(["XFER0901"]);
    expect(codes("[ 1 2.5 true null x ]")).toEqual(["XFER0903"]);
  });

  it("escapes every control character, and nothing else", () => {
    for (let c = 0; c < 0x80; c++) {
      const text = toJson({ kind: "string", value: String.fromCharCode(c) }).text;
      expect(text).toBe(JSON.stringify(String.fromCharCode(c)));
    }
    const literal = "\u007f  \u{1F600}";
    expect(toJson({ kind: "string", value: literal }).text).toBe(`"${literal}"`);
  });

  it("clamps the indent as JSON.stringify does", () => {
    const value = parseValue("[ 1 ]");
    expect(toJson(value, { indent: Number.POSITIVE_INFINITY }).text).toBe(
      JSON.stringify([1], null, 10),
    );
    expect(toJson(value, { indent: 1.5 }).text).toBe(JSON.stringify([1], null, 1));
    expect(toJson(value, { indent: Number.NaN }).text).toBe("[1]");
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
        expect(JSON.parse(defined(back))).toEqual(JSON.parse(text));
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

  it("reads deep nesting without recursion when the limit allows it", () => {
    const depth = 200_000;
    const text = "[".repeat(depth) + "]".repeat(depth);
    const { value, diagnostics } = fromJson(text, { limits: { depth } });
    expect(diagnostics).toEqual([]);
    expect(value?.kind).toBe("sequence");
  });

  it("refuses nesting past the depth limit, once, so canonical never has to throw", () => {
    for (const depth of [256, 257, 258, 200_000]) {
      const { value, diagnostics } = fromJson("[".repeat(depth) + "]".repeat(depth));
      if (depth <= 256) {
        expect(value).toBeDefined();
        expect(() => canonical(value as XferValue)).not.toThrow();
      } else {
        expect(value).toBeUndefined();
        expect(diagnostics.map((d) => d.code)).toEqual(["XFER0602"]);
      }
    }
    expect(fromJson("[[[1]]]", { limits: { depth: 2 } }).value).toBeUndefined();
    expect(fromJson("[[[]]]", { limits: { depth: 2 } }).value).toBeUndefined();
    expect(fromJson('{"a":{}}', { limits: { depth: 1 } }).value).toBeUndefined();
  });

  it("reports a duplicate key at the key, whatever the value is", () => {
    for (const second of ["2", "[1,2,3]", '{"x":1}']) {
      const { diagnostics } = fromJson(`{"a":1,"a":${second}}`);
      expect(diagnostics.map((d) => [d.code, d.start.column])).toEqual([["XFER0905", 8]]);
    }
  });

  it("reports diagnostics in order of position, with no spurious ones", () => {
    const { diagnostics } = fromJson('{"a":1,"a":2,"b":"\\r","c":9007199254740992}');
    expect(diagnostics.map((d) => [d.code, d.start.column])).toEqual([
      ["XFER0905", 8],
      ["XFER0907", 18],
    ]);
  });

  it("treats CR, LF, tab and space as whitespace", () => {
    const { value, diagnostics } = fromJson("\r\n\t [ \r\n1\r\n] \r\n");
    expect(diagnostics).toEqual([]);
    expect(value?.kind).toBe("sequence");
  });

  it("handles any text in strings and keys", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const text = JSON.stringify([s, { [s]: s }]);
        const { value, diagnostics } = fromJson(text);
        if (s.includes("\r") || lone.test(s)) {
          expect(value).toBeUndefined();
          expect(diagnostics.every((d) => d.code === "XFER0907")).toBe(true);
        } else {
          expect(diagnostics).toEqual([]);
          const back = toJson(parseValue(canonical(value as XferValue))).text;
          expect(JSON.parse(defined(back))).toEqual(JSON.parse(text));
        }
      }),
      { numRuns: 5000 },
    );
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
      const back = fromJson(defined(text)).value;
      expect(back, c.id).toBeDefined();
      const want = toPlain(value, { integers: "bigint" });
      const got = toPlain(back as XferValue, { integers: "bigint" });
      expect(JSON.stringify(got, replacer), c.id).toBe(JSON.stringify(want, replacer));
    }
  });
});

describe("asTemporal", () => {
  const g = globalThis as { Temporal?: unknown };

  it("is undefined when the platform has no Temporal, and never polyfills", () => {
    const had = g.Temporal;
    g.Temporal = undefined;
    try {
      expect(asTemporal({ kind: "date", lexeme: "2025-08-01" })).toBeUndefined();
    } finally {
      g.Temporal = had;
    }
  });

  it("uses Temporal when present, and refuses second 60 rather than change it", () => {
    const make = (name: string) => ({ from: (text: string) => ({ name, text }) });
    const had = g.Temporal;
    g.Temporal = {
      PlainDate: make("PlainDate"),
      PlainTime: make("PlainTime"),
      PlainDateTime: make("PlainDateTime"),
      Instant: make("Instant"),
    };
    try {
      expect(asTemporal({ kind: "date", lexeme: "2025-08-01" })).toEqual({
        name: "PlainDate",
        text: "2025-08-01",
      });
      expect(asTemporal({ kind: "datetime", lexeme: "2025-08-01T09:30:00Z" })).toMatchObject({
        name: "Instant",
      });
      expect(asTemporal({ kind: "time", lexeme: "23:59:60" })).toBeUndefined();
      expect(asTemporal({ kind: "datetime", lexeme: "2016-12-31T23:59:60.5Z" })).toBeUndefined();
      expect(asTemporal({ kind: "time", lexeme: "23:59:06" })).toBeDefined();
    } finally {
      g.Temporal = had;
    }
  });
});

describe("toPlain", () => {
  it("can keep a fractional as its lexeme", () => {
    expect(toPlain(parseValue("[ 1e400 0.10 ]"), { fractionals: "lexeme" })).toEqual([
      "1e400",
      "0.10",
    ]);
    expect(toPlain(parseValue("[ 1e400 ]"))).toEqual([Number.POSITIVE_INFINITY]);
  });

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
  it("treats zero as exact whatever its exponent", () => {
    expect(asNumber({ kind: "fractional", lexeme: "0e99999999999999999999" })).toEqual({
      value: 0,
      exact: true,
    });
    expect(asDecimal({ kind: "fractional", lexeme: "0.00" })).toEqual({ digits: 0n, exponent: 0 });
  });

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
