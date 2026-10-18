import { describe, expect, it } from "vitest";
import { resolveLimits } from "../src/limits";
import { normalize } from "../src/normalize";
import { loadCases } from "./cases.ts";

const limits = resolveLimits();
const encode = (s: string) => new TextEncoder().encode(s);
const raw = (...bytes: number[]) => new Uint8Array(bytes);

/** The one diagnostic a rejected input produces, as [code, offset, line, column]. */
function rejection(input: string | Uint8Array, l = limits) {
  const result = normalize(input, l);
  expect(result.text).toBe("");
  expect(result.diagnostics).toHaveLength(1);
  const d = result.diagnostics[0];
  return [d?.code, d?.start.offset, d?.start.line, d?.start.column];
}

describe("normalize, byte input", () => {
  it("decodes UTF-8 and reports the input size", () => {
    const result = normalize(encode("{ a 1 }"), limits);
    expect(result).toEqual({ text: "{ a 1 }", diagnostics: [], inputBytes: 7 });
  });

  it("accepts an empty input, leaving it to the parser to say a document needs an element", () => {
    expect(normalize(new Uint8Array(0), limits)).toEqual({
      text: "",
      diagnostics: [],
      inputBytes: 0,
    });
  });

  it("removes one leading byte order mark and no more", () => {
    expect(normalize(raw(0xef, 0xbb, 0xbf, 0x7b, 0x7d), limits).text).toBe("{}");
    expect(normalize(raw(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x7b, 0x7d), limits).text).toBe("﻿{}");
    expect(normalize(raw(0x7b, 0xef, 0xbb, 0xbf, 0x7d), limits).text).toBe("{﻿}");
  });

  it("turns CR LF and lone CR into LF", () => {
    expect(normalize(encode("a\r\nb\rc\nd\r\r\ne\r"), limits).text).toBe("a\nb\nc\nd\n\ne\n");
  });

  it("leaves every other character alone, including NUL, controls and Unicode line separators", () => {
    const text = "a\u0000b\u0001c d\u0085e\u000bf";
    expect(normalize(encode(text), limits).text).toBe(text);
  });

  it("rejects invalid UTF-8 with XFER0701 at the start of the document", () => {
    const bad: [string, Uint8Array][] = [
      ["a byte that can never occur", raw(0xff)],
      ["a lone continuation byte", raw(0x80)],
      ["a truncated sequence", raw(0x7b, 0xe2, 0x82)],
      ["an overlong encoding", raw(0xc0, 0x80)],
      ["an encoded surrogate", raw(0xed, 0xa0, 0x80)],
      ["a value past U+10FFFF", raw(0xf4, 0x90, 0x80, 0x80)],
    ];
    for (const [what, input] of bad) {
      expect(rejection(input), what).toEqual(["XFER0701", 0, 1, 1]);
    }
  });

  it("checks the size limit before decoding", () => {
    const small = { ...limits, documentBytes: 4 };
    expect(normalize(encode("abcd"), small).text).toBe("abcd");
    expect(rejection(encode("abcde"), small)).toEqual(["XFER0601", 0, 1, 1]);
    expect(rejection(raw(0xff, 0xff, 0xff, 0xff, 0xff), small)).toEqual(["XFER0601", 0, 1, 1]);
  });
});

describe("normalize, string input", () => {
  it("normalizes the same way as byte input", () => {
    expect(normalize("﻿{}", limits)).toEqual({ text: "{}", diagnostics: [], inputBytes: 5 });
    expect(normalize("a\r\nb\rc\n", limits).text).toBe("a\nb\nc\n");
    expect(normalize("﻿﻿{}", limits).text).toBe("﻿{}");
  });

  it("agrees with byte input on well-formed text", () => {
    for (const s of ["", "{ a 1 }", "日本語", "😀   \u0000", "x\r\ny\rz", "﻿é"]) {
      expect(normalize(s, limits).text, JSON.stringify(s)).toBe(normalize(encode(s), limits).text);
    }
  });

  it("counts UTF-8 bytes, not UTF-16 units, for the size", () => {
    expect(normalize("é", limits).inputBytes).toBe(2);
    expect(normalize("😀", limits).inputBytes).toBe(4);
    const small = { ...limits, documentBytes: 2 };
    expect(normalize("é", small).text).toBe("é");
    expect(rejection("éa", small)).toEqual(["XFER0601", 0, 1, 1]);
  });

  it("measures the size as supplied, before line endings and the byte order mark change it", () => {
    expect(normalize("a\r\nb", limits).inputBytes).toBe(4);
    expect(normalize("﻿ab", limits).inputBytes).toBe(5);
  });

  it("accepts a well-formed surrogate pair", () => {
    expect(normalize("a😀b", limits).diagnostics).toEqual([]);
  });

  it("rejects a lone surrogate with XFER0701 at its position", () => {
    expect(rejection("a\ud800b")).toEqual(["XFER0701", 1, 1, 2]);
    expect(rejection("\udc00")).toEqual(["XFER0701", 0, 1, 1]);
    expect(rejection("ab\ud800")).toEqual(["XFER0701", 2, 1, 3]);
    // A high surrogate followed by another high surrogate and a valid pair: the first is alone.
    expect(rejection("\ud800😀")).toEqual(["XFER0701", 0, 1, 1]);
    // A valid pair followed by a stray low surrogate.
    expect(rejection("😀\ude00")).toEqual(["XFER0701", 4, 1, 2]);
  });

  it("counts the position in scalar values and UTF-8 bytes", () => {
    expect(rejection("😀\ud800")).toEqual(["XFER0701", 4, 1, 2]);
    expect(rejection("é日\ud800")).toEqual(["XFER0701", 5, 1, 3]);
  });

  it("reports the position in the normalized text, after the byte order mark and CRLF are gone", () => {
    expect(rejection("x\n\ud800")).toEqual(["XFER0701", 2, 2, 1]);
    expect(rejection("x\r\n\ud800")).toEqual(["XFER0701", 2, 2, 1]);
    expect(rejection("x\r\ry\ud800")).toEqual(["XFER0701", 4, 3, 2]);
    expect(rejection("﻿\ud800")).toEqual(["XFER0701", 0, 1, 1]);
  });
});

describe("normalize, against the suite's byte-level cases", () => {
  const { valid, invalid } = loadCases();
  const validInput = (id: string) => {
    const found = valid.find((c) => c.id === id);
    if (found === undefined) {
      throw new Error(`no suite case ${id}`);
    }
    return found.input;
  };

  it("rejects the invalid UTF-8 cases", () => {
    for (const id of ["bytes/701-invalid-utf8", "bytes/701-truncated-utf8"]) {
      const found = invalid.find((c) => c.id === id);
      expect(found, id).toBeDefined();
      const result = normalize(found?.input as Uint8Array, limits);
      expect(
        result.diagnostics.map((d) => d.code),
        id,
      ).toEqual(["XFER0701"]);
    }
  });

  it("removes the byte order mark from bytes/310-bom", () => {
    expect(normalize(validInput("bytes/310-bom"), limits).text).toBe("{ a 1 }\n");
  });

  it("normalizes the CRLF and lone CR cases", () => {
    expect(normalize(validInput("bytes/320-crlf-normalized"), limits).text).toBe(
      '{ text "line one\nline two" }\n',
    );
    expect(normalize(validInput("bytes/320-lone-cr-normalized"), limits).text).toBe(
      '{ text "a\nb" }',
    );
  });

  it("keeps NUL and control characters", () => {
    expect(normalize(validInput("bytes/440-string-nul-and-controls"), limits).text).toBe(
      '"a\u0000b\u0001c"',
    );
  });
});
