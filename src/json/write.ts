import { makeDiagnostic } from "../diagnostics";
import { ORIGIN } from "../position";
import type { Diagnostic, ToJsonOptions, XferValue } from "../types";

// Specification 8.1. The compact form is what the conformance suite compares.

const SAFE = 2n ** 53n;

const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  8: "\\b",
  9: "\\t",
  10: "\\n",
  12: "\\f",
  13: "\\r",
};

/** Whether any character needs an escape: a control character, `"` or `\`. */
function needsEscape(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x22 || code === 0x5c) {
      return true;
    }
  }
  return false;
}

/** A JSON string literal. Every character other than `"`, `\` and the controls is written literally. */
function quote(text: string): string {
  if (!needsEscape(text)) {
    return `"${text}"`;
  }
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += "\\\\";
    } else if (code < 0x20) {
      out += SHORT_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += text[i];
    }
  }
  return `${out}"`;
}

/** A JSON Pointer (RFC 6901) token: `~` and `/` are escaped. */
function pointerToken(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** A JSON Pointer for a message: the empty pointer is the whole document. */
function where(pointer: string): string {
  return pointer === "" ? "the root" : pointer;
}

interface Frame {
  readonly container: Extract<XferValue, { kind: "object" | "sequence" }>;
  readonly keys: readonly string[];
  readonly kids: readonly XferValue[];
  readonly pointer: string;
  next: number;
}

function openFrame(
  container: Extract<XferValue, { kind: "object" | "sequence" }>,
  pointer: string,
): Frame {
  if (container.kind === "sequence") {
    return { container, keys: [], kids: container.items, pointer, next: 0 };
  }
  return {
    container,
    keys: [...container.entries.keys()],
    kids: [...container.entries.values()],
    pointer,
    next: 0,
  };
}

/**
 * Writes a value as JSON text, in the compact form unless `indent` asks for an indented one.
 * Returns text, not a JavaScript value, so an integer of any size is written in full. Never
 * throws for a value the parser produced; a hand-built value of an unknown kind is a TypeError.
 *
 * Diagnostics have no source position (they are about a value, specification 8.1), so each
 * carries the origin and says where it applies as a JSON Pointer in the message. XFER0903 and
 * XFER0904 are reported once, with a count.
 */
export function toJson(
  value: XferValue,
  options?: ToJsonOptions,
): { readonly text: string; readonly diagnostics: readonly Diagnostic[] } {
  const stringify = options?.stringifyBigInts === true;
  const requested = options?.indent;
  // As JSON.stringify does: a whole number of spaces, at most 10.
  const indent =
    requested !== undefined && requested >= 1 ? Math.min(10, Math.floor(requested)) : 0;
  const diagnostics: Diagnostic[] = [];
  let symbols = 0;
  let temporals = 0;
  let firstSymbol = "";
  let firstTemporal = "";
  const out: string[] = [];
  const stack: Frame[] = [];

  const newline = (depth: number): string =>
    indent === 0 ? "" : `\n${" ".repeat(indent * depth)}`;

  // Writes a scalar, or opens a container (and returns true).
  const emit = (v: XferValue, pointer: string): boolean => {
    switch (v.kind) {
      case "object":
      case "sequence": {
        const empty = v.kind === "object" ? v.entries.size === 0 : v.items.length === 0;
        if (empty) {
          out.push(v.kind === "object" ? "{}" : "[]");
          return false;
        }
        out.push(v.kind === "object" ? "{" : "[");
        stack.push(openFrame(v, pointer));
        return true;
      }
      case "string":
        out.push(quote(v.value));
        return false;
      case "integer": {
        const big = v.value > SAFE || v.value < -SAFE;
        if (big) {
          diagnostics.push(makeDiagnostic("XFER0901", ORIGIN, ORIGIN, `${where(pointer)}`));
        }
        out.push(big && stringify ? `"${v.value}"` : v.value.toString());
        return false;
      }
      case "fractional":
        if (v.lexeme === "inf" || v.lexeme === "-inf" || v.lexeme === "nan") {
          diagnostics.push(
            makeDiagnostic("XFER0902", ORIGIN, ORIGIN, `${v.lexeme} at ${where(pointer)}`),
          );
          out.push("null");
        } else {
          out.push(v.lexeme.replaceAll("_", ""));
        }
        return false;
      case "bool":
        out.push(v.value ? "true" : "false");
        return false;
      case "null":
        out.push("null");
        return false;
      case "symbol":
        if (symbols++ === 0) {
          firstSymbol = pointer;
        }
        out.push(quote(v.name));
        return false;
      case "date":
      case "time":
      case "local-datetime":
      case "datetime":
        if (temporals++ === 0) {
          firstTemporal = pointer;
        }
        out.push(quote(v.lexeme));
        return false;
      default:
        throw new TypeError(
          `${JSON.stringify((v as { kind: unknown }).kind)} is not a kind of value`,
        );
    }
  };

  emit(value, "");
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    const depth = stack.length;
    if (frame.next === frame.kids.length) {
      stack.pop();
      out.push(newline(depth - 1), frame.container.kind === "object" ? "}" : "]");
      continue;
    }
    const index = frame.next++;
    if (index > 0) {
      out.push(",");
    }
    out.push(newline(depth));
    let step: string;
    if (frame.container.kind === "object") {
      step = pointerToken(frame.keys[index] as string);
      out.push(quote(frame.keys[index] as string), indent === 0 ? ":" : ": ");
    } else {
      step = String(index);
    }
    emit(frame.kids[index] as XferValue, `${frame.pointer}/${step}`);
  }

  if (symbols > 0) {
    diagnostics.push(
      makeDiagnostic(
        "XFER0903",
        ORIGIN,
        ORIGIN,
        `${symbols} symbol${symbols === 1 ? "" : "s"}, first at ${where(firstSymbol)}`,
      ),
    );
  }
  if (temporals > 0) {
    diagnostics.push(
      makeDiagnostic(
        "XFER0904",
        ORIGIN,
        ORIGIN,
        `${temporals} temporal${temporals === 1 ? "" : "s"}, first at ${where(firstTemporal)}`,
      ),
    );
  }
  return { text: out.join(""), diagnostics };
}
