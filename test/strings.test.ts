import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/index";
import { canonical, parse } from "../src/index";
import { resolveLimits } from "../src/limits";
import { parseDocument } from "../src/parser";
import { chooseDelimiter, writeString } from "../src/strings";

const defaults = resolveLimits();
const LIMIT = 64;

/** Parses the text of a string literal as a whole document and returns its content. */
function read(
  text: string,
  runLength: number = LIMIT,
): { content: string | undefined; codes: string[] } {
  const diagnostics: Diagnostic[] = [];
  const { tree } = parseDocument(text, { ...defaults, runLength }, diagnostics);
  const root = tree.root;
  const token = root?.kind === "scalar" ? root.token : undefined;
  return { content: token?.content, codes: diagnostics.map((d) => d.code) };
}

describe("chooseDelimiter (specification 6, rule 10)", () => {
  const rep = (run: number) => ({ form: "rep", run });
  const hash = (run: number) => ({ form: "hash", run });

  it("uses one quote when the content has none", () => {
    for (const content of [
      "",
      "plain",
      "with #hash and <tags> and \\ backslashes",
      "日本語",
      "a\nb",
    ]) {
      expect(chooseDelimiter(content, LIMIT), JSON.stringify(content)).toEqual(rep(1));
    }
  });

  it("uses repetition one longer than the longest run, when no quote is at an end", () => {
    expect(chooseDelimiter('a"b', LIMIT)).toEqual(rep(3)); // 2 would be the empty string
    expect(chooseDelimiter('a" "b', LIMIT)).toEqual(rep(3));
    expect(chooseDelimiter('a""b', LIMIT)).toEqual(rep(3));
    expect(chooseDelimiter('a"""b', LIMIT)).toEqual(rep(4));
    expect(chooseDelimiter('a"b""c""""d', LIMIT)).toEqual(rep(5));
    expect(chooseDelimiter('x "# y', LIMIT)).toEqual(rep(3)); // a quote in the middle is not an edge
  });

  it("uses hash-run when a quote is at either end, with one more hash than any run after a quote", () => {
    expect(chooseDelimiter('"', LIMIT)).toEqual(hash(1));
    expect(chooseDelimiter('""', LIMIT)).toEqual(hash(1));
    expect(chooseDelimiter('"a', LIMIT)).toEqual(hash(1));
    expect(chooseDelimiter('a"', LIMIT)).toEqual(hash(1));
    expect(chooseDelimiter('"a"', LIMIT)).toEqual(hash(1));
    expect(chooseDelimiter('"#x"', LIMIT)).toEqual(hash(2));
    expect(chooseDelimiter('"a"##', LIMIT)).toEqual(hash(3));
    expect(chooseDelimiter('#"', LIMIT)).toEqual(hash(1)); // a hash before a quote is not a hash after one
  });

  it("takes the smallest unused length when the preferred one passes the limit", () => {
    // Runs of 1 and 3 with a limit of 3: 4 is too long, 2 is the empty string, and 1 and 3 are used,
    // so the smallest free length of the same form is 4, which is past the limit. It is used anyway.
    expect(chooseDelimiter('a"b"""c', 3)).toEqual(rep(4));
    // A run of 5 with a limit of 3 leaves 1 free, and 1 is within the limit.
    expect(chooseDelimiter('a"""""b', 3)).toEqual(rep(1));
    // A quote is at the start, so only hash-run can write this. Runs of 1 and 2 hashes follow
    // quotes, so 1 and 2 are both used and the smallest free length, 3, is past the limit of 2.
    // It is still used, because the string must be written.
    expect(chooseDelimiter('"#a"##b', 2)).toEqual(hash(3));
    // A run of 2 after a quote, limit 2: the preferred 3 is too long, and 1 is free.
    expect(chooseDelimiter('"##x', 2)).toEqual(hash(1));
  });

  it("exceeds the limit rather than fail, when no length within it is free", () => {
    // Quote runs 1, 3, 4, 5 and hash runs after a quote 1 to 5, with a limit of 5.
    const content = 'x"""#x""""##x"""""###x"####x"#####x';
    const chosen = chooseDelimiter(content, 5);
    expect(chosen).toEqual(rep(6));
    expect(read(writeString(content, 5), 6)).toEqual({ content, codes: [] });
  });

  it("writes content with a quote at an edge and hash runs of every length up to the default limit", () => {
    // The case no real document has. Hash-run is the only form for a quote at the edge, and every
    // hash length from 1 to 64 follows a quote, so the delimiter needs 65: one past the limit.
    let content = "";
    for (let n = 1; n <= 64; n++) {
      content += `"${"#".repeat(n)}x`;
    }
    expect(chooseDelimiter(content, 64)).toEqual(hash(65));
    const text = writeString(content, 64);
    // A parser at the default limit reports it, as the specification says, and does not read it wrongly.
    expect(read(text, 64).codes).toEqual(["XFER0604"]);
    // A parser that admits longer runs reads it back exactly.
    expect(read(text, 65)).toEqual({ content, codes: [] });
  });
});

describe("writeString", () => {
  it("writes the literal, with no escaping of anything", () => {
    expect(writeString("", LIMIT)).toBe('""');
    expect(writeString("plain", LIMIT)).toBe('"plain"');
    expect(writeString('say "hi"', LIMIT)).toBe('#"say "hi""#');
    expect(writeString('He said "hi" today', LIMIT)).toBe('"""He said "hi" today"""');
    expect(writeString("C:\\Users\\paul\n\ttab", LIMIT)).toBe('"C:\\Users\\paul\n\ttab"');
    expect(writeString('"#x"', LIMIT)).toBe('##""#x""##');
  });

  it("leaves the content's bytes unchanged inside the delimiters", () => {
    for (const content of [
      "a\u0000b",
      "😀 é 日本",
      "</ not a comment />",
      '<! not "an" annotation !>',
    ]) {
      const text = writeString(content, LIMIT);
      expect(text.includes(content), JSON.stringify(content)).toBe(true);
      expect(read(text).content).toBe(content);
    }
  });
});

describe("the embedding invariant (specification 2)", () => {
  // Any string, written and read back, is the same string. This is the property the language is for.
  const alphabets: [string, string[]][] = [
    ["quotes and hashes", ['"', "#", "a", " ", "\n"]],
    ["quotes only", ['"', "x"]],
    ["hashes after quotes", ['"', "#", "#"]],
    [
      "code and markup",
      ['"', "#", "{", "}", "<", "!", "/", ">", "\\", "'", "(", ")", "a", " ", "\n", "\t"],
    ],
    ["unicode and controls", ["é", "日", "😀", "\u0000", "\u0001", "\u2028", "\u00a0", '"', "#"]],
  ];

  for (const [name, alphabet] of alphabets) {
    it(`holds for any string over ${name}`, () => {
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 64 }), (chars) => {
          const content = chars.join("");
          const text = writeString(content, LIMIT);
          const result = read(text);
          expect(result.codes, JSON.stringify(content)).toEqual([]);
          expect(result.content, JSON.stringify(content)).toBe(content);
        }),
        { numRuns: 4000 },
      );
    });
  }

  it("holds under a smaller run-length limit, whenever the string fits within it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('"', "#", "a"), { maxLength: 40 }),
        fc.integer({ min: 3, max: 8 }),
        (chars, limit) => {
          const content = chars.join("");
          const chosen = chooseDelimiter(content, limit);
          if (chosen.run > limit) {
            return; // nothing fits within the limit; covered by the test above
          }
          const result = read(writeString(content, limit), limit);
          expect(result.codes, JSON.stringify([content, limit])).toEqual([]);
          expect(result.content, JSON.stringify([content, limit])).toBe(content);
        },
      ),
      { numRuns: 4000 },
    );
  });

  // Strings assembled from runs of quotes and hashes of any length, so that the hard cases are
  // reached on purpose: quotes at either edge, a hash run after a quote, runs at and past the
  // default limit of 64. A flat alphabet almost never builds a run of 64.
  const runs = fc.oneof(
    fc.integer({ min: 1, max: 70 }).map((n) => '"'.repeat(n)),
    fc.integer({ min: 1, max: 70 }).map((n) => `"${"#".repeat(n)}`),
    fc.integer({ min: 1, max: 70 }).map((n) => "#".repeat(n)),
    fc.constantFrom("a", " ", "\n", "x"),
  );
  const structured = fc.array(runs, { minLength: 0, maxLength: 7 }).map((parts) => parts.join(""));

  it("holds for strings built from runs of quotes and hashes of any length, at the edges and the limit", () => {
    fc.assert(
      fc.property(structured, (content) => {
        const text = writeString(content, LIMIT);
        // A delimiter can pass the limit only for content no real document has; read it with a
        // parser that admits longer runs, so that every case is a check on the content.
        const result = read(text, 200);
        expect(result.codes, JSON.stringify(content)).toEqual([]);
        expect(result.content, JSON.stringify(content)).toBe(content);
      }),
      { numRuns: 8000 },
    );
  });

  it("stays within the default limit for every such string that has a delimiter that fits", () => {
    fc.assert(
      fc.property(structured, (content) => {
        const chosen = chooseDelimiter(content, LIMIT);
        const fits = read(writeString(content, LIMIT), LIMIT);
        if (chosen.run <= LIMIT) {
          expect(fits.codes, JSON.stringify(content)).toEqual([]);
          expect(fits.content, JSON.stringify(content)).toBe(content);
        } else {
          expect(fits.codes, JSON.stringify(content)).toEqual(["XFER0604"]);
        }
      }),
      { numRuns: 8000 },
    );
  });

  it("holds for keys as well as values, through the canonical writer", () => {
    fc.assert(
      fc.property(structured, (key) => {
        const value = {
          kind: "object" as const,
          entries: new Map([[key, { kind: "integer" as const, value: 1n, lexeme: "1" }]]),
        };
        const result = parse(canonical(value), { limits: { runLength: 200 } });
        const entries = result.value?.kind === "object" ? [...result.value.entries.keys()] : [];
        expect(result.diagnostics, JSON.stringify(key)).toEqual([]);
        expect(entries, JSON.stringify(key)).toEqual([key]);
      }),
      { numRuns: 4000 },
    );
  });

  it("composes: a document in a document in a document holds the innermost text unchanged", () => {
    const innermost =
      'function greet(name) { console.log("Hello, " + name + "!"); }\n// "quoted" # <! x !>';
    let text = innermost;
    for (let level = 0; level < 5; level++) {
      // Each level is a document whose one member holds the previous level's text as a string.
      text = `{ payload ${writeString(text, LIMIT)} }`;
    }
    let value = parse(text).value;
    for (let level = 0; level < 5; level++) {
      expect(value?.kind).toBe("object");
      const payload = value?.kind === "object" ? value.entries.get("payload") : undefined;
      expect(payload?.kind).toBe("string");
      const inner = payload?.kind === "string" ? payload.value : "";
      if (level === 4) {
        expect(inner).toBe(innermost);
      } else {
        value = parse(inner).value;
      }
    }
  });

  it("costs one delimiter character per level of nesting", () => {
    // A string that is a member of a document that is itself a string, and so on. The innermost
    // text has a quote in the middle, so the first level takes three; each level after takes one more.
    let text = 'say "hello" there';
    const runs: number[] = [];
    for (let level = 0; level < 8; level++) {
      const literal = writeString(text, LIMIT);
      runs.push(chooseDelimiter(text, LIMIT).run);
      text = `{ payload ${literal} }`;
    }
    expect(runs).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("never rewrites the content: the innermost bytes are in the outermost text, as they were", () => {
    const innermost = 'a "quoted" word, a #hash and a \\ backslash';
    let text = innermost;
    for (let level = 0; level < 6; level++) {
      text = `{ payload ${writeString(text, LIMIT)} }`;
    }
    // No escaping happened at any level, so the text still contains the innermost, byte for byte.
    expect(text.includes(innermost)).toBe(true);
  });
});
