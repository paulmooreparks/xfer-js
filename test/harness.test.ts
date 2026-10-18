import { describe, expect, it } from "vitest";
import type { Document, Token, XferValue } from "../src/index";
import { loadCases } from "./cases.ts";
import { loadExpectedFailures } from "./expected.ts";
import { reconstruct, tokensInOrder } from "./lossless.ts";
import { memberOrder, toTagged } from "./tagged.ts";
import { readTxtar } from "./txtar.ts";

describe("readTxtar", () => {
  it("ignores text before the first entry and keeps each entry's final newline", () => {
    const entries = readTxtar("comment\nmore\n-- a.xfer --\n42\n-- b.xfer --\n[ 1 ]\n");
    expect([...entries]).toEqual([
      ["a.xfer", "42\n"],
      ["b.xfer", "[ 1 ]\n"],
    ]);
  });

  it("handles a file with no final newline", () => {
    expect([...readTxtar("-- a --\nx")]).toEqual([["a", "x"]]);
  });

  it("gives an empty entry the empty string, and preserves blank lines inside an entry", () => {
    const entries = readTxtar("-- empty --\n-- blank --\n\n\nx\n\n");
    expect(entries.get("empty")).toBe("");
    expect(entries.get("blank")).toBe("\n\nx\n\n");
  });

  it("treats a line that only resembles a header as content", () => {
    const entries = readTxtar("-- a --\n-- not a header\n--x--\n");
    expect(entries.get("a")).toBe("-- not a header\n--x--\n");
  });

  it("rejects a duplicate entry name", () => {
    expect(() => readTxtar("-- a --\n1\n-- a --\n2\n")).toThrow(/duplicate entry "a"/);
  });
});

const str = (value: string): XferValue => ({ kind: "string", value });
const int = (n: bigint): XferValue => ({ kind: "integer", value: n, lexeme: n.toString() });

describe("toTagged", () => {
  it("tags every scalar kind", () => {
    const cases: [XferValue, unknown][] = [
      [str("x"), { type: "string", value: "x" }],
      [int(42n), { type: "integer", value: "42" }],
      [
        { kind: "integer", value: 255n, lexeme: "0xFF" },
        { type: "integer", value: "255" },
      ],
      [
        { kind: "fractional", lexeme: "1_000.5" },
        { type: "fractional", value: "1000.5" },
      ],
      [
        { kind: "fractional", lexeme: "-inf" },
        { type: "fractional", value: "-inf" },
      ],
      [
        { kind: "bool", value: false },
        { type: "bool", value: "false" },
      ],
      [{ kind: "null" }, { type: "null" }],
      [
        { kind: "symbol", name: "dark" },
        { type: "symbol", value: "dark" },
      ],
      [
        { kind: "date", lexeme: "2025-08-01" },
        { type: "date", value: "2025-08-01" },
      ],
      [
        { kind: "time", lexeme: "09:30:00" },
        { type: "time", value: "09:30:00" },
      ],
      [
        { kind: "local-datetime", lexeme: "2025-08-01T09:30:00" },
        { type: "local-datetime", value: "2025-08-01T09:30:00" },
      ],
      [
        { kind: "datetime", lexeme: "2025-08-01T09:30:00Z" },
        { type: "datetime", value: "2025-08-01T09:30:00Z" },
      ],
    ];
    for (const [value, tagged] of cases) {
      expect(toTagged(value)).toEqual(tagged);
    }
  });

  it("tags containers and keeps annotations ahead of the type", () => {
    const value: XferValue = {
      kind: "object",
      entries: new Map<string, XferValue>([
        ["z", int(1n)],
        [
          "a",
          {
            kind: "sequence",
            items: [str("x")],
            annotations: [{ name: "tag", value: { kind: "symbol", name: "t" } }],
          },
        ],
      ]),
    };
    const tagged = toTagged(value);
    expect(tagged).toEqual({
      type: "object",
      value: {
        z: { type: "integer", value: "1" },
        a: {
          annotations: [{ name: "tag", value: { type: "symbol", value: "t" } }],
          type: "sequence",
          value: [{ type: "string", value: "x" }],
        },
      },
    });
    expect(memberOrder(tagged)).toEqual([["z", "a"]]);
  });

  it("converts empty containers", () => {
    expect(toTagged({ kind: "object", entries: new Map() })).toEqual({ type: "object", value: {} });
    expect(toTagged({ kind: "sequence", items: [] })).toEqual({ type: "sequence", value: [] });
  });

  it("keeps a member named __proto__ as an own member", () => {
    const value: XferValue = {
      kind: "object",
      entries: new Map<string, XferValue>([["__proto__", int(1n)]]),
    };
    const tagged = toTagged(value) as { value: object };
    expect(Object.keys(tagged.value)).toEqual(["__proto__"]);
  });

  it("does not overflow the stack on very deep nesting", () => {
    let value: XferValue = { kind: "sequence", items: [] };
    for (let i = 0; i < 100_000; i++) {
      value = { kind: "sequence", items: [value] };
    }
    expect(toTagged(value)).toBeTypeOf("object");
  });
});

describe("memberOrder", () => {
  it("distinguishes member orders that structural equality cannot", () => {
    const a = { type: "object", value: { z: { type: "null" }, a: { type: "null" } } };
    const b = { type: "object", value: { a: { type: "null" }, z: { type: "null" } } };
    expect(a).toEqual(b);
    expect(memberOrder(a)).not.toEqual(memberOrder(b));
  });
});

// A hand-built tree for `{ a 1 }`, with the whitespace as leading trivia.
const P = { offset: 0, line: 1, column: 1 };
function tok(kind: Token["kind"], text: string, leading = ""): Token {
  return {
    kind,
    start: P,
    end: P,
    text,
    leading: leading === "" ? [] : [{ kind: "whitespace", start: P, end: P, text: leading }],
  };
}

describe("reconstruct", () => {
  it("rebuilds the source from the tokens and their trivia, in order", () => {
    const doc: Document = {
      head: undefined,
      root: {
        kind: "object",
        open: tok("lbrace", "{"),
        close: tok("rbrace", "}", " "),
        pairs: [
          {
            key: tok("identifier", "a", " "),
            value: { kind: "scalar", token: tok("integer", "1", " "), annotations: [] },
            annotations: [],
            skipped: [],
          },
        ],
        annotations: [],
      },
      trailing: [],
      eof: tok("eof", ""),
      text: "{ a 1 }",
    };
    expect(reconstruct(doc)).toBe("{ a 1 }");
    expect(tokensInOrder(doc).map((t) => t.kind)).toEqual([
      "lbrace",
      "identifier",
      "integer",
      "rbrace",
      "eof",
    ]);
  });

  it("puts the head and annotations before what they attach to", () => {
    const doc: Document = {
      head: {
        open: tok("annot-open", "<!"),
        name: tok("identifier", "xfer", " "),
        value: { kind: "scalar", token: tok("integer", "1", " "), annotations: [] },
        close: tok("annot-close", "!>", " "),
      },
      root: {
        kind: "sequence",
        open: tok("lbrack", "[", "\n"),
        close: tok("rbrack", "]", " "),
        items: [],
        annotations: [],
      },
      trailing: [],
      eof: tok("eof", ""),
      text: "<! xfer 1 !>\n[ ]",
    };
    expect(reconstruct(doc)).toBe("<! xfer 1 !>\n[ ]");
  });
});

describe("the suite", () => {
  const { valid, invalid } = loadCases();

  it("loads cases of both kinds", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it("has unique case ids", () => {
    const ids = [...valid, ...invalid].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every invalid case at least one required diagnostic", () => {
    for (const c of invalid) {
      expect(c.diagnostics.length, c.id).toBeGreaterThan(0);
    }
  });

  it("lists only existing cases in expected-failures.txt", () => {
    const known = new Set([...valid, ...invalid].map((c) => c.id));
    const stale = [...loadExpectedFailures()].filter((id) => !known.has(id));
    expect(stale).toEqual([]);
  });
});
