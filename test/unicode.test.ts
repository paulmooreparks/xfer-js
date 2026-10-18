import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isAdmittedNonAscii,
  isIdentifierContinue,
  isIdentifierStart,
  isWhitespace,
  utf8ByteLength,
  utf8Length,
} from "../src/unicode";

const SPEC = fileURLToPath(new URL("../suite/spec/xferlang.md", import.meta.url));

/** The excluded code points, read from the sentence in specification 4.3 that lists them. */
function specExclusions(): Set<number> {
  const line = readFileSync(SPEC, "utf8")
    .split("\n")
    .find((l) => l.includes("An admitted non-ASCII scalar value"));
  if (line === undefined) {
    throw new Error("the specification no longer has the sentence this test reads");
  }
  // Everything after "except" lists the exclusions; the "U+0080" before it is the lower bound.
  const listed = line.slice(line.indexOf("except"));
  const out = new Set<number>();
  for (const m of listed.matchAll(/U\+([0-9A-F]{4,6})(?: to U\+([0-9A-F]{4,6}))?/g)) {
    const lo = Number.parseInt(m[1] as string, 16);
    const hi = m[2] === undefined ? lo : Number.parseInt(m[2], 16);
    for (let cp = lo; cp <= hi; cp++) {
      out.add(cp);
    }
  }
  return out;
}

describe("isAdmittedNonAscii", () => {
  const excluded = specExclusions();

  it("reads the whole exclusion list from the specification", () => {
    // 19 Unicode space characters and 19 format and bidirectional controls.
    expect(excluded.size).toBe(38);
  });

  it("agrees with the specification for every code point from U+0080 to U+10FFFF", () => {
    const wrong: string[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      const surrogate = cp >= 0xd800 && cp <= 0xdfff;
      const expected = !surrogate && !excluded.has(cp);
      if (isAdmittedNonAscii(cp) !== expected) {
        wrong.push(`U+${cp.toString(16).toUpperCase()}`);
        if (wrong.length === 10) {
          break;
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("rejects ASCII, values past the Unicode range, and surrogates", () => {
    for (const cp of [0x00, 0x20, 0x41, 0x7f, 0x110000, 0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      expect(isAdmittedNonAscii(cp), `U+${cp.toString(16)}`).toBe(false);
    }
  });

  it("admits the code points beside the excluded ranges", () => {
    for (const cp of [
      0x80,
      0x9f,
      0xa1,
      0x167f,
      0x1681,
      0x200a + 0x6,
      0x2027,
      0x2065,
      0x206a,
      0x3001,
    ]) {
      expect(isAdmittedNonAscii(cp), `U+${cp.toString(16)}`).toBe(!excluded.has(cp));
    }
    expect(isAdmittedNonAscii(0x2065)).toBe(true);
    expect(isAdmittedNonAscii(0xe9)).toBe(true);
    expect(isAdmittedNonAscii(0x65e5)).toBe(true);
    expect(isAdmittedNonAscii(0x1f600)).toBe(true);
  });
});

describe("identifier characters", () => {
  const cp = (s: string) => s.codePointAt(0) as number;

  it("starts with an ASCII letter, an underscore or an admitted non-ASCII character", () => {
    for (const c of ["a", "Z", "_", "é", "日", "ß", "😀"]) {
      expect(isIdentifierStart(cp(c)), c).toBe(true);
    }
    for (const c of ["0", "9", "-", ".", " ", " ", "{", '"', "#", "<", "​", "⁦"]) {
      expect(isIdentifierStart(cp(c)), JSON.stringify(c)).toBe(false);
    }
  });

  it("continues with those, digits, a hyphen or a dot", () => {
    for (const c of ["a", "_", "é", "0", "9", "-", "."]) {
      expect(isIdentifierContinue(cp(c)), c).toBe(true);
    }
    for (const c of [" ", "\t", "\n", "{", "}", "[", "]", '"', "#", "<", "!", " ", "﻿"]) {
      expect(isIdentifierContinue(cp(c)), JSON.stringify(c)).toBe(false);
    }
  });
});

describe("isWhitespace", () => {
  it("is space, tab, line feed and form feed", () => {
    for (const c of [0x20, 0x09, 0x0a, 0x0c]) {
      expect(isWhitespace(c)).toBe(true);
    }
  });

  it("is nothing else, including CR, vertical tab and the Unicode spaces", () => {
    for (const c of [0x0d, 0x0b, 0x00, 0xa0, 0x2003, 0x2028, 0x3000, 0xfeff]) {
      expect(isWhitespace(c), `U+${c.toString(16)}`).toBe(false);
    }
  });
});

describe("utf8Length", () => {
  it("changes size at the UTF-8 boundaries", () => {
    const cases: [number, number][] = [
      [0x00, 1],
      [0x7f, 1],
      [0x80, 2],
      [0x7ff, 2],
      [0x800, 3],
      [0xffff, 3],
      [0x10000, 4],
      [0x10ffff, 4],
    ];
    for (const [cp, length] of cases) {
      expect(utf8Length(cp), `U+${cp.toString(16)}`).toBe(length);
    }
  });
});

describe("utf8ByteLength", () => {
  const encoder = new TextEncoder();

  it("agrees with the platform encoder", () => {
    for (const s of ["", "a", "é", "日本語", "😀", "a😀b", "\u0000", "﻿", "x\r\ny"]) {
      expect(utf8ByteLength(s), JSON.stringify(s)).toBe(encoder.encode(s).length);
    }
  });

  it("agrees with the platform encoder across the whole Unicode range", () => {
    for (let cp = 0; cp <= 0x10ffff; cp += 7) {
      if (cp >= 0xd800 && cp <= 0xdfff) {
        continue;
      }
      const s = String.fromCodePoint(cp);
      if (utf8ByteLength(s) !== encoder.encode(s).length) {
        expect.fail(`U+${cp.toString(16)}`);
      }
    }
  });

  it("counts a lone surrogate as three bytes, as the replacement character would be", () => {
    expect(utf8ByteLength("\ud800")).toBe(3);
    expect(utf8ByteLength("\udc00")).toBe(3);
    expect(utf8ByteLength("\ud800a")).toBe(4);
    expect(utf8ByteLength("\ud800𐀀")).toBe(7);
  });
});
