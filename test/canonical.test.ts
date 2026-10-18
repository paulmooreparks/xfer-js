import { describe, expect, it } from "vitest";
import type { XferValue } from "../src/index";
import { canonical, parse, XferError } from "../src/index";
import { tokenize } from "../src/lexer";
import { resolveLimits } from "../src/limits";
import { normalize } from "../src/normalize";
import { loadCases } from "./cases.ts";
import {
  generate,
  randomSeparator,
  renderDocument,
  taggedDocument,
  tightSeparator,
} from "./generator.ts";
import { mulberry32, pick } from "./random.ts";
import { toTaggedDocument } from "./tagged.ts";

const defaults = resolveLimits();
const canon = (text: string) => canonical(parse(text));

const str = (value: string, annotations?: XferValue["annotations"]): XferValue =>
  annotations === undefined ? { kind: "string", value } : { kind: "string", value, annotations };
const int = (n: bigint): XferValue => ({ kind: "integer", value: n, lexeme: n.toString() });
const seq = (...items: XferValue[]): XferValue => ({ kind: "sequence", items });
const obj = (...pairs: [string, XferValue][]): XferValue => ({
  kind: "object",
  entries: new Map(pairs),
});

describe("layout (specification 6, rules 1 to 4)", () => {
  it("writes the specification's own example", () => {
    expect(canon('{a 1   b [1 2]  c "x"}')).toBe(
      '{\n    a 1\n    b [\n        1\n        2\n    ]\n    c "x"\n}\n',
    );
  });

  it("indents four spaces a level, puts each member on its own line, and ends with one LF", () => {
    expect(canon("[ [ [ 1 ] ] ]")).toBe(
      "[\n    [\n        [\n            1\n        ]\n    ]\n]\n",
    );
    expect(canon("42").endsWith("\n")).toBe(true);
    expect(canon("42").endsWith("\n\n")).toBe(false);
  });

  it("writes an empty collection as {} or [] on the line it belongs to", () => {
    expect(canon("{ }")).toBe("{}\n");
    expect(canon("[ ]")).toBe("[]\n");
    expect(canon("[ [] {} ]")).toBe("[\n    []\n    {}\n]\n");
    expect(canon("{ a [] b {} }")).toBe("{\n    a []\n    b {}\n}\n");
  });

  it("writes a scalar root on one line", () => {
    expect(canon("42")).toBe("42\n");
    expect(canon('"text"')).toBe('"text"\n');
    expect(canon("null")).toBe("null\n");
  });

  it("drops comments and keeps the order of members", () => {
    expect(canon("{ z 1 </ gone /> a 2 m 3 }")).toBe("{\n    z 1\n    a 2\n    m 3\n}\n");
  });

  it("writes UTF-8 with LF line endings and no byte order mark, whatever the input had", () => {
    const text = canonical(
      parse(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x20, 0x61, 0x20, 0x31, 0x0d, 0x0a, 0x7d])),
    );
    expect(text).toBe("{\n    a 1\n}\n");
    expect(text.includes("\r")).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("the xfer head and annotations (rules 2 and 6)", () => {
  it("writes the head first, on its own line, only when the source had one", () => {
    expect(canon("<! xfer 1 !> [ 1 ]")).toBe("<! xfer 1 !>\n[\n    1\n]\n");
    expect(canon("[ 1 ]")).toBe("[\n    1\n]\n");
    expect(canon("<!xfer 1!>{a 1}")).toBe("<! xfer 1 !>\n{\n    a 1\n}\n");
  });

  it("writes annotations on their own lines before their target, after the head", () => {
    expect(canon("<! xfer 1 !> <! tag a !> 1")).toBe("<! xfer 1 !>\n<! tag a !>\n1\n");
    expect(canon('[ <! tag a !> <! id "x" !> 1 2 ]')).toBe(
      '[\n    <! tag a !>\n    <! id "x" !>\n    1\n    2\n]\n',
    );
  });

  it("writes a pair's annotations before its key, at the pair's indentation", () => {
    expect(canon('{ <! id "k" !> a [ 1 ] b 2 }')).toBe(
      '{\n    <! id "k" !>\n    a [\n        1\n    ]\n    b 2\n}\n',
    );
  });

  it("keeps the order of several annotations, and the kind of their values", () => {
    expect(canon('<! tag "two words" !> <! tag sym !> <! lang js !> 1')).toBe(
      '<! tag "two words" !>\n<! tag sym !>\n<! lang js !>\n1\n',
    );
  });

  it("refuses an annotation a document cannot carry, instead of writing one that reads back differently", () => {
    const annotated = (name: string, value: XferValue) => str("x", [{ name, value }]);
    // `xfer` is the head and not an annotation of a value, `foo` is unknown, and the third would
    // put text into the structure of the document.
    for (const name of ["xfer", "foo", "x y !> 1 <! tag", "", "ID"]) {
      expect(() => canonical(annotated(name, str("v"))), JSON.stringify(name)).toThrow(TypeError);
    }
    // Wrong kinds of value, and a container, which no annotation takes.
    expect(() => canonical(annotated("id", { kind: "symbol", name: "a" }))).toThrow(TypeError);
    expect(() => canonical(annotated("tag", int(1n)))).toThrow(TypeError);
    expect(() => canonical(annotated("tag", seq()))).toThrow(TypeError);
    expect(() => canonical(annotated("lang", obj()))).toThrow(TypeError);
    // An annotation inside an annotation's value, and an id used twice.
    expect(() => canonical(annotated("tag", str("v", [{ name: "tag", value: str("w") }])))).toThrow(
      TypeError,
    );
    const withId = (id: string) => str("v", [{ name: "id", value: str(id) }]);
    expect(() => canonical(seq(withId("k"), withId("k")))).toThrow(TypeError);
    // What is allowed.
    expect(canonical(annotated("id", str("k")))).toBe('<! id "k" !>\n"x"\n');
    expect(canonical(annotated("tag", { kind: "symbol", name: "t" }))).toBe('<! tag t !>\n"x"\n');
    expect(canonical(seq(withId("a"), withId("b")))).toContain('<! id "b" !>');
  });

  it("refuses a lexeme that is not the number or time it claims to be", () => {
    for (const lexeme of ["", "1 } x", " 1", "1 ", "0xzz", "1.5", "1__0", "0755"]) {
      expect(
        () => canonical({ kind: "integer", value: 1n, lexeme }),
        JSON.stringify(lexeme),
      ).toThrow(TypeError);
    }
    expect(() => canonical({ kind: "integer", value: 2n, lexeme: "1" })).toThrow(TypeError); // not that value
    expect(() => canonical({ kind: "integer", value: 1n } as never)).toThrow(TypeError);
    for (const lexeme of ["", "1", "1 2", "x", "1.", "true"]) {
      expect(() => canonical({ kind: "fractional", lexeme }), JSON.stringify(lexeme)).toThrow(
        TypeError,
      );
    }
    expect(() => canonical({ kind: "date", lexeme: "2025-13-01" })).toThrow(TypeError);
    expect(() => canonical({ kind: "time", lexeme: "09:30" })).toThrow(TypeError);
    expect(() => canonical({ kind: "datetime", lexeme: "2025-08-01" })).toThrow(TypeError); // a date
    expect(() => canonical({ kind: "widget" } as never)).toThrow(TypeError);
    // What is allowed, including the special floats and a hexadecimal integer.
    expect(canonical({ kind: "integer", value: 255n, lexeme: "0xFF" })).toBe("0xff\n");
    expect(canonical({ kind: "fractional", lexeme: "1e5" })).toBe("1e5\n");
    expect(canonical({ kind: "fractional", lexeme: "-inf" })).toBe("-inf\n");
    expect(canonical({ kind: "date", lexeme: "2025-08-01" })).toBe("2025-08-01\n");
  });
});

describe("keys, numbers and the rest (rules 5 and 7 to 9)", () => {
  it("writes a key bare when it is an identifier that is not a keyword, otherwise as a string", () => {
    const text = canon(
      '{ "first name" 1 "true" 2 "inf" 3 a.b 4 "a." 5 "" 6 "日本" 7 "a b" 8 menu-id 9 "9a" 10 }',
    );
    expect(text).toBe(
      '{\n    "first name" 1\n    "true" 2\n    "inf" 3\n    a.b 4\n    "a." 5\n    "" 6\n    日本 7\n    "a b" 8\n    menu-id 9\n    "9a" 10\n}\n',
    );
  });

  it("writes a key that needs quotes with the same choice rule as any string", () => {
    expect(canon('{ #"say "hi""# 1 }')).toBe('{\n    #"say "hi""# 1\n}\n');
    expect(canon('{ """a "b" c""" 1 }')).toBe('{\n    """a "b" c""" 1\n}\n');
  });

  it("lower-cases the digits of a hexadecimal integer and changes nothing else about a number", () => {
    const text = canon(
      "[ 0xFF -0xAB_cd 0o17 0b1_0 1_000 -0 123456789012345678901234567890 1E5 2.5e+3 0.50 1_0.0_1 ]",
    );
    expect(
      text
        .split("\n")
        .slice(1, -2)
        .map((s) => s.trim()),
    ).toEqual([
      "0xff",
      "-0xab_cd",
      "0o17",
      "0b1_0",
      "1_000",
      "-0",
      "123456789012345678901234567890",
      "1E5",
      "2.5e+3",
      "0.50",
      "1_0.0_1",
    ]);
  });

  it("writes the special floats, keywords, symbols and temporals as spelled", () => {
    const text = canon(
      "[ inf -inf nan true false null Dark read-only v1.2.3 2025-08-01 09:30:00.250 2025-08-01T09:30:00+08:00 ]",
    );
    expect(
      text
        .split("\n")
        .slice(1, -2)
        .map((s) => s.trim()),
    ).toEqual([
      "inf",
      "-inf",
      "nan",
      "true",
      "false",
      "null",
      "Dark",
      "read-only",
      "v1.2.3",
      "2025-08-01",
      "09:30:00.250",
      "2025-08-01T09:30:00+08:00",
    ]);
  });

  it("refuses a string or key that no document can hold, instead of writing one that reads back differently", () => {
    // U+000D is normalized away when a document is read, so it cannot be part of a value; a lone
    // surrogate is not a scalar value. Either would be corrupted silently on the way back.
    for (const bad of ["a\rb", "\r", "a\r\nb", "x\ud800y", "\udc00", "\ud83d"]) {
      expect(() => canonical(str(bad)), JSON.stringify(bad)).toThrow(TypeError);
      expect(() => canonical(obj([bad, int(1n)])), JSON.stringify(bad)).toThrow(TypeError);
    }
    // Everything else is writable, including a well-formed pair and the other control characters.
    for (const fine of ["a\nb", "a\tb", "😀", "\u0000", " "]) {
      expect(parse(canonical(str(fine))).value, JSON.stringify(fine)).toEqual(str(fine));
    }
  });

  it("refuses a hand-built symbol that no document could contain, instead of writing a wrong one", () => {
    for (const name of ["has space", "true", "a.", "", "9a", "x{y}"]) {
      expect(() => canonical({ kind: "symbol", name }), JSON.stringify(name)).toThrow(TypeError);
    }
  });
});

describe("what canonical accepts", () => {
  it("takes a parse result, which keeps the xfer head, or a value, which has none", () => {
    const result = parse("<! xfer 1 !> { a 1 }");
    expect(canonical(result)).toBe("<! xfer 1 !>\n{\n    a 1\n}\n");
    // A value has no head, since a value does not remember where it came from.
    expect(canonical(result.value as XferValue)).toBe("{\n    a 1\n}\n");
  });

  it("refuses anything that is neither, with a TypeError", () => {
    // A bare tree is refused: it cannot say whether the parse that made it had an error.
    for (const bad of [{ a: 1 }, null, undefined, 42, "text", [], parse("1").tree]) {
      expect(() => canonical(bad as never), String(bad)).toThrow(TypeError);
    }
  });

  it("refuses a result that claims success but has no value", () => {
    const lie = { ...parse("1"), value: undefined };
    expect(() => canonical(lie)).toThrow(XferError);
  });

  it("refuses a parse result that has an error, with the parse's own diagnostics", () => {
    const result = parse("{ a }");
    let thrown: unknown;
    try {
      canonical(result);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(XferError);
    expect((thrown as XferError).diagnostics.map((d) => d.code)).toEqual(["XFER0404"]);
  });

  it("refuses every document with an error, including those whose tree has a value", () => {
    // None of these is visible in the shape of its tree: a repeated key, an unsupported version,
    // a nested annotation, a dropped annotation, an unknown annotation, and one of the wrong type.
    // Writing any of them from the tree alone would change what the document says.
    for (const text of [
      "{ a 1 a 2 }",
      "<! xfer 2 !> 1",
      "<! tag <! tag y !> x !> 1",
      "{ a <! tag x !> 1 }",
      "<! foo 1 !> 1",
      "<! id 5 !> 1",
      "{ a }",
      "[ 1 2",
      "1 ~",
    ]) {
      expect(() => canonical(parse(text)), text).toThrow(XferError);
    }
  });

  it("uses the run-length limit it is given", () => {
    // A run of 64 quotes, the most the default limit admits: 65 would be too long, so the writer
    // takes the smallest length the content does not use, which is 1. With the limit raised, 65 is
    // allowed and is the preferred length.
    const value = str(`x${'"'.repeat(64)}x`);
    const lowered = canonical(value);
    const raised = canonical(value, { limits: { runLength: 128 } });
    expect(lowered.startsWith('"x')).toBe(true);
    expect(raised.startsWith('"'.repeat(65))).toBe(true);
    expect(parse(lowered).value).toEqual(value);
    expect(parse(raised, { limits: { runLength: 128 } }).value).toEqual(value);
  });
});

describe("limits", () => {
  const nest = (depth: number): XferValue => {
    let value: XferValue = seq(int(1n));
    for (let i = 1; i < depth; i++) {
      value = seq(value);
    }
    return value;
  };

  it("refuses a value nested deeper than the depth limit, because the output grows with its square", () => {
    expect(() => canonical(nest(257))).toThrow(XferError);
    expect(() => canonical(nest(257))).toThrow(/nested more than 256/);
    expect(canonical(nest(256)).length).toBeGreaterThan(100_000);
  });

  it("takes the depth limit it is given, so a result parsed with raised limits can be written", () => {
    const limits = { depth: 3000 };
    const result = parse("[".repeat(3000) + "]".repeat(3000), { limits });
    expect(result.ok).toBe(true);
    expect(() => canonical(result)).toThrow(XferError);
    const text = canonical(result, { limits });
    expect(text.startsWith("[\n    [\n        [\n")).toBe(true);
  });
});

describe("round trips", () => {
  const SEEDS = 1500;

  it("write every generated document so that it reads back to the same value, and writing it again changes nothing", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = generate(seed);
      const random = mulberry32(seed * 7919);
      const text = renderDocument(doc, randomSeparator(random), pick(random, ["", " ", "\n"]));
      const where = `seed ${seed}: ${JSON.stringify(text)}`;
      const first = parse(text);
      expect(first.ok, where).toBe(true);
      const once = canonical(first);
      const second = parse(once);
      expect(second.diagnostics, where).toEqual([]);
      expect(toTaggedDocument(second), where).toEqual(taggedDocument(doc));
      expect(canonical(second), `idempotent, ${where}`).toBe(once);
    }
  });

  it("write the same bytes whatever the spacing of the source", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = generate(seed);
      const random = mulberry32(seed * 104729);
      const loose = canonical(parse(renderDocument(doc, randomSeparator(random), "")));
      const tight = canonical(parse(renderDocument(doc, tightSeparator, "")));
      expect(tight, `seed ${seed}`).toBe(loose);
    }
  });

  it("write the same bytes for every valid suite document with its whitespace collapsed", () => {
    // The whitespace invariant (specification 2): replacing any run of whitespace between tokens
    // with a single space changes nothing. Comments stay, and strings are never touched.
    const { valid } = loadCases();
    for (const c of valid) {
      const text = normalize(c.input, defaults).text;
      const collapsed = tokenize(text, defaults, [])
        .map((t) => t.leading.map((x) => (x.kind === "comment" ? x.text : " ")).join("") + t.text)
        .join("");
      const result = parse(collapsed);
      expect(result.diagnostics, c.id).toEqual([]);
      expect(canonical(result), c.id).toBe(c.canonical);
    }
  });

  it("are stable for any text that parses, found by fuzzing", () => {
    const pieces = [
      "{",
      "}",
      "[",
      "]",
      '"a"',
      '"x y"',
      "1",
      "0xFF",
      "2.5",
      "true",
      "null",
      "a",
      "b",
      "dark",
      " <! tag t !> ",
      " ",
      "\n",
      "</ c />",
      '#"q "r""#',
      '"""a "b" c"""',
    ];
    const random = mulberry32(777);
    let parsed = 0;
    for (let run = 0; run < 20_000; run++) {
      let text = "";
      for (let i = Math.floor(random() * 14); i > 0; i--) {
        text += `${pick(random, pieces)} `;
      }
      const result = parse(text);
      if (!result.ok) {
        continue;
      }
      parsed++;
      const once = canonical(result);
      const again = parse(once);
      expect(again.ok, JSON.stringify(text)).toBe(true);
      expect(canonical(again), JSON.stringify(text)).toBe(once);
    }
    expect(parsed).toBeGreaterThan(200); // the fuzzer must reach valid documents, or it checks nothing
  });
});

describe("size and depth", () => {
  it("writes a large document in linear time", () => {
    const items = Array.from(
      { length: 100_000 },
      (_, i) => `{ id ${i} name "n${i}" tags [ a b ] }`,
    );
    const result = parse(`[ ${items.join(" ")} ]`);
    const started = performance.now();
    const text = canonical(result);
    const elapsed = performance.now() - started;
    expect(text.length).toBeGreaterThan(2_500_000);
    // A quadratic writer would take minutes at this size; this is an order of magnitude above
    // what the writer needs on a slow runner, so it fails on the algorithm and not on the machine.
    expect(elapsed).toBeLessThan(10_000);
  });

  it("writes the deepest document the default limit allows", () => {
    const text = "[".repeat(256) + "]".repeat(256);
    const out = canonical(parse(text));
    // 255 opening lines, the innermost empty sequence on one line, 255 closing lines, and the
    // empty string after the final newline.
    expect(out.split("\n").length).toBe(255 + 1 + 255 + 1);
    expect(canonical(parse(out))).toBe(out);
  });
});
