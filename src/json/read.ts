import { makeDiagnostic } from "../diagnostics";
import type { Diagnostic, Position, XferValue } from "../types";
import { utf8Length } from "../unicode";

// Specification 8.2. A JSON reader of our own, because the platform's JSON.parse loses the
// integer/fractional distinction, the spelling of numbers, and duplicate keys.

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

/** Tracks a position in the JSON text as the reader advances; positions are asked for in order. */
class Cursor {
  private index = 0;
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly text: string) {}

  at(target: number): Position {
    const stop = Math.min(target, this.text.length);
    while (this.index < stop) {
      const cp = this.text.codePointAt(this.index) ?? 0;
      const size = cp > 0xffff ? 2 : 1;
      if (this.index + size > stop) {
        break;
      }
      this.index += size;
      this.offset += utf8Length(cp);
      if (cp === 0x0a) {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
    }
    return { offset: this.offset, line: this.line, column: this.column };
  }
}

class Malformed extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(message);
  }
}

interface Frame {
  readonly kind: "object" | "sequence";
  readonly items: XferValue[];
  readonly entries: Map<string, XferValue>;
  /** Object only: the key waiting for its value. */
  key: string | undefined;
}

function isLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Reads JSON text into a value. Malformed JSON gives XFER0906 and no value; a string or key that
 * XferLang cannot hold (U+000D, a lone surrogate) gives XFER0907 and no value, but the rest of the
 * text is still read so that every such string is reported. A duplicate key keeps the last value
 * and gives XFER0905. Iterative, so nesting depth cannot overflow the stack.
 */
export function fromJson(text: string): {
  readonly value: XferValue | undefined;
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const cursor = new Cursor(text);
  let failed = false;
  let i = 0;

  const report = (code: "XFER0905" | "XFER0907", at: number, detail: string): void => {
    const position = cursor.at(at);
    diagnostics.push(makeDiagnostic(code, position, position, detail));
    if (code === "XFER0907") {
      failed = true;
    }
  };

  const skipSpace = (): void => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        i++;
      } else {
        break;
      }
    }
  };

  // Reads a string whose opening quote is at `i`; leaves `i` after the closing quote.
  const readString = (): string => {
    const start = i;
    i++;
    let out = "";
    let from = i;
    for (;;) {
      if (i >= text.length) {
        throw new Malformed(start, "unterminated string");
      }
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(from, i);
        i++;
        break;
      }
      if (c < 0x20) {
        throw new Malformed(i, "control character in string");
      }
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(from, i);
      const e = text[i + 1];
      i += 2;
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Malformed(i - 2, "bad \\u escape");
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          throw new Malformed(i - 2, "bad escape");
      }
      from = i;
    }
    if (out.includes("\r") || isLoneSurrogate(out)) {
      report("XFER0907", start, "a string holds U+000D or a lone surrogate");
    }
    return out;
  };

  const stack: Frame[] = [];
  let result: XferValue | undefined;

  const push = (value: XferValue, at: number): void => {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      result = value;
    } else if (top.kind === "sequence") {
      top.items.push(value);
    } else {
      const key = top.key as string;
      if (top.entries.has(key)) {
        report("XFER0905", at, `duplicate key ${JSON.stringify(key)}`);
      }
      top.entries.set(key, value);
      top.key = undefined;
    }
  };

  try {
    // A value is expected at the start of the document, after `[`, after `,` in a sequence and
    // after the `:` in an object. `expectValue` says which.
    let expectValue = true;
    for (;;) {
      skipSpace();
      if (expectValue) {
        const start = i;
        const c = text[i];
        if (c === "{") {
          i++;
          stack.push({ kind: "object", items: [], entries: new Map(), key: undefined });
          skipSpace();
          if (text[i] === "}") {
            i++;
            stack.pop();
            push({ kind: "object", entries: new Map() }, start);
            expectValue = false;
          } else {
            // Read the first key.
            if (text[i] !== '"') {
              throw new Malformed(i, "expected a string key");
            }
            (stack[stack.length - 1] as Frame).key = readString();
            skipSpace();
            if (text[i] !== ":") {
              throw new Malformed(i, "expected `:`");
            }
            i++;
          }
          continue;
        }
        if (c === "[") {
          i++;
          skipSpace();
          if (text[i] === "]") {
            i++;
            push({ kind: "sequence", items: [] }, start);
            expectValue = false;
          } else {
            stack.push({
              kind: "sequence",
              items: [],
              entries: new Map(),
              key: undefined,
            });
          }
          continue;
        }
        if (c === '"') {
          const value = readString();
          push({ kind: "string", value }, start);
        } else if (text.startsWith("true", i)) {
          i += 4;
          push({ kind: "bool", value: true }, start);
        } else if (text.startsWith("false", i)) {
          i += 5;
          push({ kind: "bool", value: false }, start);
        } else if (text.startsWith("null", i)) {
          i += 4;
          push({ kind: "null" }, start);
        } else if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
          NUMBER.lastIndex = i;
          const m = NUMBER.exec(text);
          if (m === null) {
            throw new Malformed(i, "malformed number");
          }
          const lexeme = m[0];
          i += lexeme.length;
          if (m[1] === undefined && m[2] === undefined) {
            push({ kind: "integer", value: BigInt(lexeme), lexeme }, start);
          } else {
            push({ kind: "fractional", lexeme }, start);
          }
        } else {
          throw new Malformed(
            i,
            i >= text.length ? "unexpected end of text" : "unexpected character",
          );
        }
        // A literal that runs into more name characters (`truex`, `1.5.3`) is caught by the
        // delimiter check below, since only a separator may follow a value.
        expectValue = false;
        continue;
      }

      // After a value: a separator, a closer, or the end of the document.
      const top = stack[stack.length - 1];
      const c = text[i];
      if (top === undefined) {
        if (i < text.length) {
          throw new Malformed(i, "text after the value");
        }
        break;
      }
      if (c === ",") {
        i++;
        skipSpace();
        if (top.kind === "object") {
          if (text[i] !== '"') {
            throw new Malformed(i, "expected a string key");
          }
          top.key = readString();
          skipSpace();
          if (text[i] !== ":") {
            throw new Malformed(i, "expected `:`");
          }
          i++;
        }
        expectValue = true;
        continue;
      }
      if ((top.kind === "object" && c === "}") || (top.kind === "sequence" && c === "]")) {
        i++;
        stack.pop();
        const done: XferValue =
          top.kind === "object"
            ? { kind: "object", entries: top.entries }
            : { kind: "sequence", items: top.items };
        push(done, i);
        continue;
      }
      throw new Malformed(i, c === undefined ? "unexpected end of text" : "unexpected character");
    }
  } catch (e) {
    if (e instanceof Malformed) {
      const position = cursor.at(e.index);
      diagnostics.push(makeDiagnostic("XFER0906", position, position, e.message));
      return { value: undefined, diagnostics };
    }
    throw e;
  }

  return { value: failed ? undefined : result, diagnostics };
}
