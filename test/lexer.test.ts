import { describe, expect, it } from "vitest";
import type { Diagnostic, Limits, Token } from "../src/index";
import { Lexer, tokenize } from "../src/lexer";
import { resolveLimits } from "../src/limits";
import { normalize } from "../src/normalize";
import { positionAt } from "../src/position";
import { loadCases } from "./cases.ts";

const defaults = resolveLimits();

function lex(text: string, limits: Limits = defaults) {
  const diagnostics: Diagnostic[] = [];
  const tokens = tokenize(text, limits, diagnostics);
  return { tokens, diagnostics };
}

function reconstruct(tokens: readonly Token[]): string {
  return tokens.map((t) => t.leading.map((x) => x.text).join("") + t.text).join("");
}

/** Token kinds and texts, without the eof token. */
function shape(text: string): string[] {
  return lex(text)
    .tokens.filter((t) => t.kind !== "eof")
    .map((t) => `${t.kind} ${t.text}`);
}

function codes(text: string, limits: Limits = defaults): string[] {
  return lex(text, limits).diagnostics.map((d) => `${d.code} ${d.start.line}:${d.start.column}`);
}

// The diagnostics this layer produces. normalize() produces XFER0601 and XFER0701.
const LEXICAL = new Set([
  "XFER0101",
  "XFER0102",
  "XFER0103",
  "XFER0104",
  "XFER0105",
  "XFER0201",
  "XFER0202",
  "XFER0301",
  "XFER0302",
  "XFER0304",
  "XFER0305",
  "XFER0603",
  "XFER0604",
  "XFER0701",
]);

describe("the suite, at the lexical level", () => {
  const { valid, invalid } = loadCases();

  it("lexes every valid document without a diagnostic, and reproduces it exactly", () => {
    for (const c of valid) {
      const normalized = normalize(c.input, defaults);
      expect(normalized.diagnostics, c.id).toEqual([]);
      const { tokens, diagnostics } = lex(normalized.text);
      expect(
        diagnostics.map((d) => `${d.code} ${d.message}`),
        c.id,
      ).toEqual([]);
      expect(reconstruct(tokens), c.id).toBe(normalized.text);
      expect(tokens.at(-1)?.kind, c.id).toBe("eof");
    }
  });

  const lexical = invalid.filter((c) => c.diagnostics.every((d) => LEXICAL.has(d.code)));

  it("covers a meaningful share of the invalid cases", () => {
    expect(lexical.length).toBeGreaterThan(30);
  });

  for (const c of lexical) {
    it(`reports what ${c.id} requires`, () => {
      const normalized = normalize(c.input, defaults);
      const found =
        normalized.diagnostics.length > 0
          ? normalized.diagnostics
          : lex(normalized.text).diagnostics;
      for (const want of c.diagnostics) {
        const hit = found.some(
          (d) =>
            d.code === want.code &&
            (want.at === undefined ||
              (d.start.line === want.at.line && d.start.column === want.at.column)),
        );
        const got = found.map((d) => `${d.code} ${d.start.line}:${d.start.column}`).join(", ");
        expect(hit, `expected ${want.code} at ${JSON.stringify(want.at)}; got ${got}`).toBe(true);
      }
    });
  }
});

describe("brackets and annotations", () => {
  it("lexes the self-delimiting tokens with or without space", () => {
    expect(shape("{a 1 b[1 2]}")).toEqual([
      "lbrace {",
      "identifier a",
      "integer 1",
      "identifier b",
      "lbrack [",
      "integer 1",
      "integer 2",
      "rbrack ]",
      "rbrace }",
    ]);
    expect(shape("<!xfer 1!>")).toEqual([
      "annot-open <!",
      "identifier xfer",
      "integer 1",
      "annot-close !>",
    ]);
  });

  it("reports a < that opens neither a comment nor an annotation", () => {
    expect(codes("<x")).toContain("XFER0102 1:1");
  });

  it("returns eof again after the end", () => {
    const lexer = new Lexer("1", defaults, []);
    expect(lexer.next().kind).toBe("integer");
    expect(lexer.next().kind).toBe("eof");
    expect(lexer.next().kind).toBe("eof");
  });
});

describe("comments", () => {
  it("attach to the next token as trivia, with their run length", () => {
    const { tokens } = lex("</ a /> <// b </ c /> //> 1");
    const [first] = tokens;
    expect(first?.kind).toBe("integer");
    expect(first?.leading.map((t) => [t.kind, t.run ?? null])).toEqual([
      ["comment", 1],
      ["whitespace", null],
      ["comment", 2],
      ["whitespace", null],
    ]);
  });

  it("close only on a run of exactly the opening length followed by >", () => {
    expect(codes("</ a//> b /> 1")).toEqual([]);
    expect(codes("<// a /> //> 1")).toEqual([]);
    expect(codes("<// a /> 1")).toEqual(["XFER0104 1:1"]);
  });

  it("count as a separator after a scalar", () => {
    expect(shape("1</ c />2")).toEqual(["integer 1", "integer 2"]);
  });

  it("keep everything to the end of the text when unterminated", () => {
    const { tokens, diagnostics } = lex("1 </ never");
    expect(diagnostics.map((d) => d.code)).toEqual(["XFER0104"]);
    expect(tokens.at(-1)?.leading.at(-1)?.text).toBe("</ never");
  });
});

describe("strings", () => {
  const string = (text: string) => {
    const [t] = lex(text).tokens;
    return { kind: t?.kind, content: t?.content, delimiter: t?.delimiter };
  };

  it("take their content verbatim between runs of the same length", () => {
    expect(string('"plain"')).toEqual({
      kind: "string",
      content: "plain",
      delimiter: { form: "rep", run: 1 },
    });
    expect(string('""say "hi" now""')).toEqual({
      kind: "string",
      content: 'say "hi" now',
      delimiter: { form: "rep", run: 2 },
    });
    expect(string('"C:\\Users\\n"').content).toBe("C:\\Users\\n");
    expect(string('"a\nb"').content).toBe("a\nb");
  });

  it("treat a run of a different length as content (exact matching)", () => {
    expect(string('"a""b"').content).toBe('a""b');
    expect(string('"""x " y """').content).toBe('x " y ');
  });

  it("read the empty string", () => {
    expect(string('""')).toEqual({
      kind: "string",
      content: "",
      delimiter: { form: "rep", run: 1 },
    });
    expect(shape('[""]')).toEqual(["lbrack [", 'string ""', "rbrack ]"]);
  });

  it("read hash-run strings, whose content may begin and end with a quote", () => {
    expect(string('#"say "hi""#')).toEqual({
      kind: "string",
      content: 'say "hi"',
      delimiter: { form: "hash", run: 1 },
    });
    expect(string('##"a "# b"##').content).toBe('a "# b');
    expect(string('#""#').content).toBe("");
    expect(string('#""""#').content).toBe('""');
  });

  it("report an unterminated string at its start and keep the rest as one error token", () => {
    const { tokens, diagnostics } = lex('[ "open\n  more ]');
    expect(diagnostics.map((d) => `${d.code} ${d.start.line}:${d.start.column}`)).toEqual([
      "XFER0201 1:3",
    ]);
    expect(tokens.map((t) => t.kind)).toEqual(["lbrack", "error", "eof"]);
  });

  it("report a hash run with no quote, and carry on after the hashes", () => {
    expect(shape("#42")).toEqual(["error #", "integer 42"]);
    expect(codes("#42")).toEqual(["XFER0202 1:1"]);
  });

  it("report a delimiter run over the limit but still read the string", () => {
    const tight = { ...defaults, runLength: 3 };
    expect(codes('""""x""""', tight)).toEqual(["XFER0604 1:1"]);
    expect(lex('""""x""""', tight).tokens[0]?.content).toBe("x");
    expect(codes('####"x"####', tight)).toEqual(["XFER0604 1:1"]);
    expect(codes("<//// c ////> 1", tight)).toEqual(["XFER0604 1:1"]);
  });

  it("report a token over the length limit", () => {
    const tight = { ...defaults, tokenBytes: 4 };
    expect(codes('"ab"', tight)).toEqual([]);
    expect(codes('"abc"', tight)).toEqual(["XFER0603 1:1"]);
  });
});

describe("numbers", () => {
  it("lex every integer and fractional form", () => {
    expect(shape("0 -0 42 -7 1_000 0xFF -0x1f 0o755 0b1010_1010")).toEqual([
      "integer 0",
      "integer -0",
      "integer 42",
      "integer -7",
      "integer 1_000",
      "integer 0xFF",
      "integer -0x1f",
      "integer 0o755",
      "integer 0b1010_1010",
    ]);
    expect(shape("1.5 -0.25 6.02e23 1e5 1E-5 2.5e+3 1_000.000_1 0.5 0e5")).toEqual([
      "fractional 1.5",
      "fractional -0.25",
      "fractional 6.02e23",
      "fractional 1e5",
      "fractional 1E-5",
      "fractional 2.5e+3",
      "fractional 1_000.000_1",
      "fractional 0.5",
      "fractional 0e5",
    ]);
  });

  it("lex inf, -inf and nan as keywords", () => {
    const keywords = lex("inf -inf nan").tokens.slice(0, 3);
    expect(keywords.map((t) => [t.kind, t.keyword])).toEqual([
      ["keyword", "inf"],
      ["keyword", "-inf"],
      ["keyword", "nan"],
    ]);
  });

  it("end a token where its grammar ends", () => {
    expect(codes("1-2")).toEqual(["XFER0101 1:2"]);
    expect(codes("-infinity")).toEqual(["XFER0101 1:5"]);
    expect(codes("1.5.5")).toEqual(["XFER0101 1:4"]);
    expect(codes("0o78")).toEqual(["XFER0101 1:4"]);
    expect(shape("infinity inferno")).toEqual(["identifier infinity", "identifier inferno"]);
  });

  it("reject malformed numbers with the specific code", () => {
    expect(codes("0755")).toEqual(["XFER0301 1:1"]);
    expect(codes("-0755")).toEqual(["XFER0301 1:1"]);
    for (const bad of [
      "1.",
      "1.e5",
      "1__0",
      "1_",
      "1_a",
      "0x",
      "0x_1",
      "0XFF",
      "0O7",
      "0B1",
      "1e",
      "1e+",
      "-",
      "-x",
      "--1",
    ]) {
      expect(codes(bad), bad).toEqual(["XFER0302 1:1"]);
    }
    for (const bad of [".5", "+1"]) {
      expect(codes(bad), bad).toEqual(["XFER0103 1:1"]);
    }
  });

  it("make a malformed number one error token, so nothing cascades", () => {
    expect(shape("[ 1__0x ]")).toEqual(["lbrack [", "error 1__0x", "rbrack ]"]);
  });
});

describe("temporals", () => {
  it("lex the three forms, and the local date-time", () => {
    expect(
      shape(
        "2025-08-01 09:30:00 09:30:00.250 2025-08-01T09:30:00Z 2025-08-01T09:30:00+08:00 2025-08-01T09:30:00",
      ),
    ).toEqual([
      "date 2025-08-01",
      "time 09:30:00",
      "time 09:30:00.250",
      "datetime 2025-08-01T09:30:00Z",
      "datetime 2025-08-01T09:30:00+08:00",
      "local-datetime 2025-08-01T09:30:00",
    ]);
  });

  it("accept leap days, leap seconds and year zero", () => {
    expect(
      codes("2024-02-29 2000-02-29 23:59:60 0000-01-01 0000-02-29 2025-08-01T00:00:00-23:59"),
    ).toEqual([]);
  });

  it("reject fields that name no instant", () => {
    for (const bad of [
      "2025-02-30",
      "2023-02-29",
      "1900-02-29",
      "2025-13-01",
      "2025-00-10",
      "2025-04-31",
      "25:00:00",
      "24:00:00",
      "23:60:00",
      "23:59:61",
      "2025-08-01T09:30:00+24:00",
      "2025-08-01T09:30:00+08:60",
    ]) {
      expect(codes(bad), bad).toEqual(["XFER0305 1:1"]);
    }
  });

  it("reject the wrong shape", () => {
    for (const bad of [
      "2025-08",
      "2025-8-01",
      "09:30",
      "09:30:00.",
      "2025-08-01T",
      "2025-08-01T09:30",
      "2025-08-01T09:30:00+0800",
      "2025-08-01T09:30:00+08",
    ]) {
      expect(codes(bad), bad).toEqual(["XFER0304 1:1"]);
    }
  });

  it("take no sign, no digit separator, no lowercase t or z, and no space", () => {
    expect(codes("-2025-08-01")).toEqual(["XFER0101 1:6"]);
    expect(codes("2_025-08-01")).toEqual(["XFER0101 1:6"]);
    expect(codes("2025-08-01t09:30:00")).toEqual(["XFER0101 1:11"]);
    expect(codes("2025-08-01T09:30:00z")).toEqual(["XFER0101 1:20"]);
    expect(shape("2025-08-01 09:30:00")).toEqual(["date 2025-08-01", "time 09:30:00"]);
    expect(codes("9:30:00")).toEqual(["XFER0101 1:2"]);
  });
});

describe("identifiers and keywords", () => {
  it("lex keywords case-sensitively", () => {
    expect(shape("true false null True NULL")).toEqual([
      "keyword true",
      "keyword false",
      "keyword null",
      "identifier True",
      "identifier NULL",
    ]);
  });

  it("lex hyphens, dots, underscores and non-ASCII letters", () => {
    expect(shape("menu-id a.b.c v1.2.3 _private naïve 日本語 größe")).toEqual([
      "identifier menu-id",
      "identifier a.b.c",
      "identifier v1.2.3",
      "identifier _private",
      "identifier naïve",
      "identifier 日本語",
      "identifier größe",
    ]);
  });

  it("report an identifier that ends with a dot, and keep it an identifier", () => {
    expect(codes("a.")).toEqual(["XFER0105 1:1"]);
    expect(codes("true.")).toEqual(["XFER0105 1:1"]);
    expect(shape("true.")).toEqual(["identifier true."]);
  });

  it("stop at an excluded character, which then fails the separation rule", () => {
    expect(codes("a\u00a0b")).toEqual(["XFER0101 1:2"]);
    expect(codes("a\u200bb")).toEqual(["XFER0101 1:2"]);
  });
});

describe("faults and recovery", () => {
  it("report text that runs on after a scalar once, as one error token", () => {
    const { tokens, diagnostics } = lex("[ 1-2 ]");
    expect(diagnostics.map((d) => `${d.code} ${d.start.column} ${d.message}`)).toEqual([
      'XFER0101 4 scalar token not followed by a separator: found "-"',
    ]);
    expect(tokens.map((t) => `${t.kind} ${t.text}`)).toEqual([
      "lbrack [",
      "integer 1",
      "error -2",
      "rbrack ]",
      "eof ",
    ]);
  });

  it("report a character that cannot begin a token once, without cascading", () => {
    expect(codes("{ a ~true b 1 }")).toEqual(["XFER0103 1:5"]);
    expect(shape("{ a ~true b 1 }")).toContain("error ~true");
  });

  it("explain the characters people bring from other formats", () => {
    const message = (text: string) => lex(text).diagnostics[0]?.message ?? "";
    expect(message("[ 1, 2 ]")).toContain("commas");
    expect(message('{ "a": 1 }')).toContain("colon");
    expect(message("['x']")).toContain('quoted with "');
    expect(message("( 1 )")).toContain("no tuples");
  });
});

describe("positions", () => {
  it("count lines from 1, columns in scalar values, and offsets in UTF-8 bytes", () => {
    const { tokens } = lex("é\n  日 😀x 1");
    const at = (i: number) => {
      const t = tokens[i];
      return [t?.text, t?.start.offset, t?.start.line, t?.start.column, t?.end.offset];
    };
    expect(at(0)).toEqual(["é", 0, 1, 1, 2]);
    expect(at(1)).toEqual(["日", 5, 2, 3, 8]);
    expect(at(2)).toEqual(["😀x", 9, 2, 5, 14]);
    expect(at(3)).toEqual(["1", 15, 2, 8, 16]);
  });
});

// A small deterministic generator, so a failure reproduces.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("any input", () => {
  const alphabet = [
    ...'{}[]<>!/"#-._:,+~? \n\t01279axeETZn',
    "inf",
    "true",
    "é",
    "😀",
    "\u00a0",
    "</",
    "<!",
    "!>",
    '""',
    '#"',
    '"#',
    "2025-08-01",
    "09:30:00",
  ];

  it("lexes without throwing, reproduces the text, and reports true positions", () => {
    const random = mulberry32(20261018);
    for (let run = 0; run < 3000; run++) {
      const pieces = Math.floor(random() * 24);
      let text = "";
      for (let i = 0; i < pieces; i++) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      const { tokens } = lex(text);
      expect(reconstruct(tokens), JSON.stringify(text)).toBe(text);

      // Every token and every piece of trivia starts where an independent count says it should.
      let prefix = "";
      for (const token of tokens) {
        for (const trivia of token.leading) {
          expect(trivia.start, JSON.stringify(text)).toEqual(positionAt(text, prefix.length));
          prefix += trivia.text;
        }
        expect(token.start, JSON.stringify(text)).toEqual(positionAt(text, prefix.length));
        prefix += token.text;
        expect(token.end, JSON.stringify(text)).toEqual(positionAt(text, prefix.length));
      }
      expect(tokens.at(-1)?.kind).toBe("eof");
    }
  });
});
