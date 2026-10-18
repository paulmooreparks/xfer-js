// The character classes the specification defines. Everything here works on code points
// (numbers), so the lexer can walk a string by code point without allocating.

// Specification 4.3: scalar values at or above U+0080 that identifiers may not contain. Listed
// as the specification lists them, unmerged, so that each can be checked against its text.
const EXCLUDED: readonly (readonly [number, number])[] = [
  // Unicode space characters
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2028],
  [0x2029, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
  // Format and bidirectional controls
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
];

/** Specification 3.3: space, tab, line feed and form feed. CR is gone after normalization. */
export function isWhitespace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0c;
}

/** A scalar value at or above U+0080 that is not in the excluded list. Surrogates are not scalar values. */
export function isAdmittedNonAscii(cp: number): boolean {
  if (cp < 0x80 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return false;
  }
  for (const [lo, hi] of EXCLUDED) {
    if (cp >= lo && cp <= hi) {
      return false;
    }
  }
  return true;
}

function isAsciiLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function isAsciiDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

/** An ASCII letter, `_`, or an admitted non-ASCII scalar value. */
export function isIdentifierStart(cp: number): boolean {
  return isAsciiLetter(cp) || cp === 0x5f || isAdmittedNonAscii(cp);
}

/** An identifier-start character, an ASCII digit, `-` or `.`. */
export function isIdentifierContinue(cp: number): boolean {
  return isIdentifierStart(cp) || isAsciiDigit(cp) || cp === 0x2d || cp === 0x2e;
}

/** The number of bytes UTF-8 uses for a code point. */
export function utf8Length(cp: number): 1 | 2 | 3 | 4 {
  if (cp < 0x80) {
    return 1;
  }
  if (cp < 0x800) {
    return 2;
  }
  return cp < 0x10000 ? 3 : 4;
}

/** The UTF-8 size of a string. A lone surrogate counts as three bytes, as U+FFFD would. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
