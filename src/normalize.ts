import type { DiagnosticCode } from "./diagnostics";
import { makeDiagnostic } from "./diagnostics";
import { ORIGIN, positionAt } from "./position";
import type { Diagnostic, Limits } from "./types";
import { utf8ByteLength } from "./unicode";

export interface Normalized {
  /** Empty when a diagnostic prevented decoding. */
  readonly text: string;
  readonly diagnostics: Diagnostic[];
  /** The size of the input as supplied, before the byte order mark and line endings are touched. */
  readonly inputBytes: number;
}

// A high surrogate with no low one after it, or a low surrogate with no high one before it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const BOM = 0xfeff;

function rejected(code: DiagnosticCode, inputBytes: number, at = ORIGIN): Normalized {
  return { text: "", diagnostics: [makeDiagnostic(code, at)], inputBytes };
}

function platformTooLarge() {
  return makeDiagnostic("XFER0601", ORIGIN, ORIGIN, "larger than this platform can decode");
}

/** Specification 3.2: every CR LF and every lone CR becomes LF. */
function lineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Turns supplied input into the normalized text every later stage works on (specification 3.1
 * and 3.2): valid UTF-8 or well-formed UTF-16, one leading byte order mark removed, and LF line
 * endings. Positions reported by the lexer and parser are positions in this text.
 *
 * Invalid UTF-8 is reported at the start of the document, because the platform decoder does not
 * say where it failed. A lone surrogate in a string input is reported where it is.
 */
export function normalize(input: string | Uint8Array, limits: Limits): Normalized {
  return typeof input === "string" ? normalizeString(input, limits) : normalizeBytes(input, limits);
}

function normalizeBytes(input: Uint8Array, limits: Limits): Normalized {
  const inputBytes = input.length;
  if (inputBytes > limits.documentBytes) {
    return rejected("XFER0601", inputBytes);
  }
  let decoded: string;
  try {
    // ignoreBOM false is the setting that removes a leading byte order mark.
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input);
  } catch (error) {
    // The Encoding standard defines a TypeError for bytes that are not UTF-8. Any other failure
    // is the platform being unable to hold the decoded text, which is a size problem, not an
    // encoding one; the core reports it rather than throwing.
    if (error instanceof TypeError) {
      return rejected("XFER0701", inputBytes);
    }
    return { text: "", diagnostics: [platformTooLarge()], inputBytes };
  }
  return { text: lineEndings(decoded), diagnostics: [], inputBytes };
}

function normalizeString(input: string, limits: Limits): Normalized {
  const inputBytes = utf8ByteLength(input);
  if (inputBytes > limits.documentBytes) {
    return rejected("XFER0601", inputBytes);
  }
  const unmarked = input.charCodeAt(0) === BOM ? input.slice(1) : input;
  const text = lineEndings(unmarked);
  const lone = LONE_SURROGATE.exec(text);
  if (lone !== null) {
    return rejected("XFER0701", inputBytes, positionAt(text, lone.index));
  }
  return { text, diagnostics: [], inputBytes };
}
