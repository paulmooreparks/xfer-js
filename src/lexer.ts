import type { DiagnosticCode } from "./diagnostics";
import { makeDiagnostic } from "./diagnostics";
import type { Diagnostic, Limits, Position, Token, TokenKind, Trivia } from "./types";
import { isIdentifierContinue, isIdentifierStart, isWhitespace, utf8Length } from "./unicode";

const LF = 0x0a;
const BANG = 0x21;
const QUOTE = 0x22;
const HASH = 0x23;
const PLUS = 0x2b;
const MINUS = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const ZERO = 0x30;
const COLON = 0x3a;
const LT = 0x3c;
const GT = 0x3e;
const UPPER_E = 0x45;
const UPPER_T = 0x54;
const UPPER_Z = 0x5a;
const LBRACK = 0x5b;
const RBRACK = 0x5d;
const UNDERSCORE = 0x5f;
const LOWER_E = 0x65;
const LBRACE = 0x7b;
const RBRACE = 0x7d;

type Keyword = NonNullable<Token["keyword"]>;
interface Delimiter {
  readonly form: "rep" | "hash";
  readonly run: number;
}
interface Extra {
  readonly content?: string;
  readonly delimiter?: Delimiter;
  readonly keyword?: Keyword;
}

const KEYWORDS: ReadonlySet<string> = new Set(["true", "false", "null", "inf", "nan"]);

const isDecimal = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDecimal(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isOctal = (c: number) => c >= 0x30 && c <= 0x37;
const isBinary = (c: number) => c === 0x30 || c === 0x31;

// The letter after a leading 0 that makes a radix prefix, and the digits it admits.
const RADIX: Readonly<Record<number, (c: number) => boolean>> = {
  120: isHex,
  111: isOctal,
  98: isBinary,
};
const UPPERCASE_RADIX: ReadonlySet<number> = new Set([0x58, 0x4f, 0x42]);

// Characters people bring from other formats, with what to write instead.
const HINTS: Readonly<Record<string, string>> = {
  ",": "elements are separated by whitespace, not commas",
  ":": "a key and its value are separated by whitespace, not a colon",
  "'": 'strings are quoted with "',
  "(": "there are no tuples; a sequence is written in [ ]",
  ")": "there are no tuples; a sequence is written in [ ]",
  "+": "a number takes no + sign",
  ".": "a fractional number needs a digit before the point",
  "~": "booleans are written true and false",
  "?": "null is written null",
};

function daysIn(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function validDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

// Second 60 is a leap second, which RFC 3339 permits.
function validTime(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 60;
}

function quoted(cp: number): string {
  return cp < 0 ? "end of input" : JSON.stringify(String.fromCodePoint(cp));
}

/** The detail for a diagnostic about an unexpected character, with a hint when there is one. */
function found(cp: number): string {
  const hint = cp < 0 ? undefined : HINTS[String.fromCodePoint(cp)];
  return hint === undefined ? `found ${quoted(cp)}` : `found ${quoted(cp)}; ${hint}`;
}

/**
 * Turns normalized text into tokens, each carrying the trivia (whitespace and comments) before
 * it. Never throws: every fault is a diagnostic, and the text of a malformed token becomes an
 * `error` token, so the tokens and their trivia always reproduce the text exactly.
 *
 * DESIGN.md section 5 is the reference. A token ends where its grammar ends, and the separation
 * rule (specification 4) is checked there: `1-2` is `1` followed by an error at `-`.
 */
export class Lexer {
  private readonly text: string;
  private readonly limits: Limits;
  private readonly diagnostics: Diagnostic[];
  private index = 0;
  private offset = 0;
  private line = 1;
  private column = 1;
  // Holds the error token for text that ran on after a scalar, returned by the next call.
  private readonly queue: Token[] = [];

  constructor(text: string, limits: Limits, diagnostics: Diagnostic[]) {
    this.text = text;
    this.limits = limits;
    this.diagnostics = diagnostics;
  }

  /** The next token. At the end of the text, an `eof` token every time. */
  next(): Token {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    const leading = this.trivia();
    return this.token(leading);
  }

  // Reading the text.

  private position(): Position {
    return { offset: this.offset, line: this.line, column: this.column };
  }

  /** The UTF-16 unit at an index, or -1 past the end. Enough for every ASCII decision. */
  private code(i = this.index): number {
    return i < this.text.length ? this.text.charCodeAt(i) : -1;
  }

  /** The code point at the current index, or -1 at the end. */
  private point(): number {
    return this.index < this.text.length ? (this.text.codePointAt(this.index) ?? -1) : -1;
  }

  private advance(): void {
    const cp = this.point();
    if (cp < 0) {
      return;
    }
    this.index += cp > 0xffff ? 2 : 1;
    this.offset += utf8Length(cp);
    if (cp === LF) {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
  }

  /** Consumes a run of one ASCII character and returns its length. */
  private run(c: number): number {
    let n = 0;
    while (this.code() === c) {
      this.advance();
      n++;
    }
    return n;
  }

  /** Specification 4: what may follow a scalar token. A comment begins with `<`, so it counts. */
  private atTerminator(): boolean {
    const c = this.code();
    return (
      c < 0 ||
      isWhitespace(c) ||
      c === LBRACE ||
      c === RBRACE ||
      c === LBRACK ||
      c === RBRACK ||
      c === LT ||
      (c === BANG && this.code(this.index + 1) === GT)
    );
  }

  private report(code: DiagnosticCode, at: Position, detail?: string): void {
    this.diagnostics.push(makeDiagnostic(code, at, at, detail));
  }

  private make(
    kind: TokenKind,
    startIndex: number,
    start: Position,
    leading: readonly Trivia[],
    extra: Extra = {},
  ): Token {
    const text = this.text.slice(startIndex, this.index);
    return { kind, start, end: this.position(), text, leading, ...extra };
  }

  // Trivia.

  private trivia(): Trivia[] {
    const out: Trivia[] = [];
    for (;;) {
      const c = this.code();
      if (c >= 0 && isWhitespace(c)) {
        const startIndex = this.index;
        const start = this.position();
        while (isWhitespace(this.code())) {
          this.advance();
        }
        const text = this.text.slice(startIndex, this.index);
        out.push({ kind: "whitespace", start, end: this.position(), text });
      } else if (c === LT && this.code(this.index + 1) === SLASH) {
        out.push(this.comment());
      } else {
        return out;
      }
    }
  }

  /** Specification 4.1: closes at the first run of exactly n slashes that is followed by `>`. */
  private comment(): Trivia {
    const startIndex = this.index;
    const start = this.position();
    this.advance();
    const n = this.run(SLASH);
    if (n > this.limits.runLength) {
      this.report("XFER0604", start, `a run of ${n} slashes`);
    }
    for (;;) {
      const c = this.code();
      if (c < 0) {
        this.report("XFER0104", start);
        break;
      }
      if (c === SLASH) {
        if (this.run(SLASH) === n && this.code() === GT) {
          this.advance();
          break;
        }
      } else {
        this.advance();
      }
    }
    const text = this.text.slice(startIndex, this.index);
    return { kind: "comment", start, end: this.position(), text, run: n };
  }

  // Tokens.

  private token(leading: readonly Trivia[]): Token {
    const startIndex = this.index;
    const start = this.position();
    const c = this.code();
    const single = (kind: TokenKind) => {
      this.advance();
      return this.make(kind, startIndex, start, leading);
    };
    switch (c) {
      case -1:
        return this.make("eof", startIndex, start, leading);
      case LBRACE:
        return single("lbrace");
      case RBRACE:
        return single("rbrace");
      case LBRACK:
        return single("lbrack");
      case RBRACK:
        return single("rbrack");
      case LT:
        // `</` was taken as a comment, so this `<` begins an annotation or nothing.
        this.advance();
        if (this.code() === BANG) {
          this.advance();
          return this.make("annot-open", startIndex, start, leading);
        }
        this.report("XFER0102", start);
        return this.make("error", startIndex, start, leading);
      case BANG:
        if (this.code(this.index + 1) === GT) {
          this.advance();
          this.advance();
          return this.make("annot-close", startIndex, start, leading);
        }
        return this.unexpected(startIndex, start, leading);
      case QUOTE:
        return this.repetitionString(startIndex, start, leading);
      case HASH:
        return this.hashString(startIndex, start, leading);
      default:
        break;
    }
    if (isDecimal(c) || c === MINUS) {
      return this.number(startIndex, start, leading);
    }
    if (isIdentifierStart(this.point())) {
      return this.word(startIndex, start, leading);
    }
    return this.unexpected(startIndex, start, leading);
  }

  /** Finishes a scalar token: the token-length limit, then the separation rule. */
  private scalar(token: Token): Token {
    if (token.end.offset - token.start.offset > this.limits.tokenBytes) {
      this.report("XFER0603", token.start);
    }
    if (!this.atTerminator()) {
      const startIndex = this.index;
      const start = this.position();
      this.report("XFER0101", start, found(this.point()));
      while (!this.atTerminator()) {
        this.advance();
      }
      this.queue.push(this.make("error", startIndex, start, []));
    }
    return token;
  }

  /** Reports a malformed token and makes everything from its start to the next terminator one error token. */
  private malformed(
    code: DiagnosticCode,
    startIndex: number,
    start: Position,
    leading: readonly Trivia[],
    detail?: string,
  ): Token {
    this.report(code, start, detail);
    while (!this.atTerminator()) {
      this.advance();
    }
    return this.make("error", startIndex, start, leading);
  }

  private unexpected(startIndex: number, start: Position, leading: readonly Trivia[]): Token {
    // The character is not a terminator (dispatch handled those), so this always advances.
    return this.malformed("XFER0103", startIndex, start, leading, found(this.point()));
  }

  // Strings (specification 4.4).

  private repetitionString(startIndex: number, start: Position, leading: readonly Trivia[]): Token {
    const n = this.run(QUOTE);
    if (n > this.limits.runLength) {
      this.report("XFER0604", start, `a run of ${n} quotes`);
    }
    // A run of exactly two quotes is the empty string, whatever follows; it never opens a
    // string, so `""x""` is the empty string and then a separation error at `x`.
    if (n === 2) {
      const delimiter: Delimiter = { form: "rep", run: 1 };
      return this.scalar(
        this.make("string", startIndex, start, leading, { content: "", delimiter }),
      );
    }
    const contentStart = this.index;
    for (;;) {
      const c = this.code();
      if (c < 0) {
        this.report("XFER0201", start, `opened with a run of ${n} ${n === 1 ? "quote" : "quotes"}`);
        return this.make("error", startIndex, start, leading);
      }
      if (c === QUOTE) {
        const runStart = this.index;
        if (this.run(QUOTE) === n) {
          const content = this.text.slice(contentStart, runStart);
          const delimiter: Delimiter = { form: "rep", run: n };
          return this.scalar(
            this.make("string", startIndex, start, leading, { content, delimiter }),
          );
        }
      } else {
        this.advance();
      }
    }
  }

  private hashString(startIndex: number, start: Position, leading: readonly Trivia[]): Token {
    const m = this.run(HASH);
    if (this.code() !== QUOTE) {
      // Only the hashes are in error; lexing continues after them.
      this.report("XFER0202", start);
      return this.make("error", startIndex, start, leading);
    }
    if (m > this.limits.runLength) {
      this.report("XFER0604", start, `a run of ${m} hashes`);
    }
    this.advance();
    const contentStart = this.index;
    for (;;) {
      const c = this.code();
      if (c < 0) {
        this.report("XFER0201", start, `opened with ${"#".repeat(Math.min(m, 8))}"`);
        return this.make("error", startIndex, start, leading);
      }
      if (c === QUOTE) {
        const quoteIndex = this.index;
        this.advance();
        if (this.run(HASH) === m) {
          const content = this.text.slice(contentStart, quoteIndex);
          const delimiter: Delimiter = { form: "hash", run: m };
          return this.scalar(
            this.make("string", startIndex, start, leading, { content, delimiter }),
          );
        }
      } else {
        this.advance();
      }
    }
  }

  // Numbers and temporals (specification 4.5 and 4.6).

  /** A run of digits in which a single `_` may stand between two digits. */
  private digits(isDigit: (c: number) => boolean): {
    count: number;
    underscore: boolean;
    bad: boolean;
  } {
    let count = 0;
    let underscore = false;
    for (;;) {
      const c = this.code();
      if (isDigit(c)) {
        this.advance();
        count++;
      } else if (c === UNDERSCORE) {
        const between =
          count > 0 && isDigit(this.code(this.index - 1)) && isDigit(this.code(this.index + 1));
        if (!between) {
          return { count, underscore, bad: true };
        }
        this.advance();
        underscore = true;
      } else {
        return { count, underscore, bad: false };
      }
    }
  }

  private number(startIndex: number, start: Position, leading: readonly Trivia[]): Token {
    let signed = false;
    if (this.code() === MINUS) {
      this.advance();
      signed = true;
      // `-inf` is a complete token wherever it appears; `-infinity` fails the separation rule.
      if (this.text.startsWith("inf", this.index)) {
        this.advance();
        this.advance();
        this.advance();
        return this.scalar(this.make("keyword", startIndex, start, leading, { keyword: "-inf" }));
      }
      if (!isDecimal(this.code())) {
        return this.malformed(
          "XFER0302",
          startIndex,
          start,
          leading,
          "a minus sign must be followed by digits or inf",
        );
      }
    }

    if (this.code() === ZERO) {
      const letter = this.code(this.index + 1);
      const radixDigit = RADIX[letter];
      if (radixDigit !== undefined) {
        this.advance();
        this.advance();
        const r = this.digits(radixDigit);
        if (r.count === 0 || r.bad) {
          return this.malformed(
            "XFER0302",
            startIndex,
            start,
            leading,
            "a radix prefix must be followed by digits of that radix",
          );
        }
        return this.scalar(this.make("integer", startIndex, start, leading));
      }
      if (UPPERCASE_RADIX.has(letter)) {
        return this.malformed(
          "XFER0302",
          startIndex,
          start,
          leading,
          "radix prefixes are lowercase: 0x, 0o, 0b",
        );
      }
    }

    const whole = this.digits(isDecimal);
    if (whole.bad) {
      return this.malformed(
        "XFER0302",
        startIndex,
        start,
        leading,
        "an underscore must stand between two digits",
      );
    }

    // A temporal takes no sign and no digit separators. It is checked before the leading-zero
    // rule, because years and hours may begin with 0.
    if (!signed && !whole.underscore) {
      if (whole.count === 4 && this.code() === MINUS) {
        return this.temporal(startIndex, start, leading, true);
      }
      if (whole.count === 2 && this.code() === COLON) {
        return this.temporal(startIndex, start, leading, false);
      }
    }

    const firstDigit = this.code(signed ? startIndex + 1 : startIndex);
    if (whole.count > 1 && firstDigit === ZERO) {
      return this.malformed("XFER0301", startIndex, start, leading);
    }

    let kind: "integer" | "fractional" = "integer";
    if (this.code() === DOT) {
      this.advance();
      const fraction = this.digits(isDecimal);
      if (fraction.count === 0 || fraction.bad) {
        return this.malformed(
          "XFER0302",
          startIndex,
          start,
          leading,
          "a point must be followed by digits",
        );
      }
      kind = "fractional";
    }
    const e = this.code();
    if (e === LOWER_E || e === UPPER_E) {
      this.advance();
      const sign = this.code();
      if (sign === PLUS || sign === MINUS) {
        this.advance();
      }
      const exponent = this.digits(isDecimal);
      if (exponent.count === 0 || exponent.bad) {
        return this.malformed(
          "XFER0302",
          startIndex,
          start,
          leading,
          "an exponent must have digits",
        );
      }
      kind = "fractional";
    }
    return this.scalar(this.make(kind, startIndex, start, leading));
  }

  /** Two decimal digits as a number, consumed; -1 (consuming nothing) if they are not there. */
  private twoDigits(): number {
    const a = this.code();
    const b = this.code(this.index + 1);
    if (!isDecimal(a) || !isDecimal(b)) {
      return -1;
    }
    this.advance();
    this.advance();
    return (a - ZERO) * 10 + (b - ZERO);
  }

  /** `:MM:SS` with an optional fraction, from a `:`. Undefined if the shape is wrong. */
  private timeRest(): { minute: number; second: number } | undefined {
    if (this.code() !== COLON) {
      return undefined;
    }
    this.advance();
    const minute = this.twoDigits();
    if (minute < 0 || this.code() !== COLON) {
      return undefined;
    }
    this.advance();
    const second = this.twoDigits();
    if (second < 0) {
      return undefined;
    }
    if (this.code() === DOT) {
      this.advance();
      if (!isDecimal(this.code())) {
        return undefined;
      }
      while (isDecimal(this.code())) {
        this.advance();
      }
    }
    return { minute, second };
  }

  /**
   * A date or date-time (`dated`, at the `-` after a four-digit year) or a time (at the `:` after
   * a two-digit hour). A wrong shape is XFER0304; a right shape that names no instant is XFER0305.
   */
  private temporal(
    startIndex: number,
    start: Position,
    leading: readonly Trivia[],
    dated: boolean,
  ): Token {
    const field = (from: number) => Number(this.text.slice(from, from + 2));
    let kind: TokenKind;
    let valid: boolean;

    if (dated) {
      const year = Number(this.text.slice(startIndex, startIndex + 4));
      this.advance();
      const month = this.twoDigits();
      const dash = month >= 0 && this.code() === MINUS;
      if (dash) {
        this.advance();
      }
      const day = dash ? this.twoDigits() : -1;
      if (day < 0) {
        return this.malformed("XFER0304", startIndex, start, leading, "a date is YYYY-MM-DD");
      }
      valid = validDate(year, month, day);
      kind = "date";
      if (this.code() === UPPER_T) {
        this.advance();
        const hour = this.twoDigits();
        const time = hour < 0 ? undefined : this.timeRest();
        if (time === undefined) {
          return this.malformed(
            "XFER0304",
            startIndex,
            start,
            leading,
            "a date-time is YYYY-MM-DDTHH:MM:SS",
          );
        }
        valid = valid && validTime(hour, time.minute, time.second);
        kind = "local-datetime";
        const o = this.code();
        if (o === UPPER_Z) {
          this.advance();
          kind = "datetime";
        } else if (o === PLUS || o === MINUS) {
          this.advance();
          const offsetHour = this.twoDigits();
          const colon = offsetHour >= 0 && this.code() === COLON;
          if (colon) {
            this.advance();
          }
          const offsetMinute = colon ? this.twoDigits() : -1;
          if (offsetMinute < 0) {
            return this.malformed(
              "XFER0304",
              startIndex,
              start,
              leading,
              "an offset is Z, +HH:MM or -HH:MM",
            );
          }
          valid = valid && offsetHour <= 23 && offsetMinute <= 59;
          kind = "datetime";
        }
      }
    } else {
      const hour = field(startIndex);
      const time = this.timeRest();
      if (time === undefined) {
        return this.malformed("XFER0304", startIndex, start, leading, "a time is HH:MM:SS");
      }
      valid = validTime(hour, time.minute, time.second);
      kind = "time";
    }

    if (!valid) {
      this.report("XFER0305", start);
      return this.scalar(this.make("error", startIndex, start, leading));
    }
    return this.scalar(this.make(kind, startIndex, start, leading));
  }

  // Identifiers and keywords (specification 4.2 and 4.3).

  private word(startIndex: number, start: Position, leading: readonly Trivia[]): Token {
    this.advance();
    while (isIdentifierContinue(this.point())) {
      this.advance();
    }
    const text = this.text.slice(startIndex, this.index);
    if (text.endsWith(".")) {
      this.report("XFER0105", start);
    }
    if (KEYWORDS.has(text)) {
      return this.scalar(
        this.make("keyword", startIndex, start, leading, { keyword: text as Keyword }),
      );
    }
    return this.scalar(this.make("identifier", startIndex, start, leading));
  }
}

/** Lexes a whole text, through the `eof` token. */
export function tokenize(text: string, limits: Limits, diagnostics: Diagnostic[]): Token[] {
  const lexer = new Lexer(text, limits, diagnostics);
  const tokens: Token[] = [];
  for (;;) {
    const token = lexer.next();
    tokens.push(token);
    if (token.kind === "eof") {
      return tokens;
    }
  }
}
