import { XferError } from "./error";
import { resolveLimits } from "./limits";
import { normalize } from "./normalize";
import { parseDocument } from "./parser";
import { ORIGIN } from "./position";
import type { Diagnostic, Document, ParseOptions, ParseResult, XferValue } from "./types";
import { toValue } from "./value";

/** A document for an input that could not be read at all: no head, no root, nothing after. */
function unreadable(): Document {
  const eof = { kind: "eof", start: ORIGIN, end: ORIGIN, text: "", leading: [] } as const;
  return { head: undefined, root: undefined, trailing: [], eof, text: "" };
}

/**
 * Parses a document. Never throws for any input: every fault is a diagnostic. `value` is present
 * exactly when there is no diagnostic of severity "error"; `tree` is always present and holds
 * whatever the parser could read.
 */
export function parse(input: string | Uint8Array, options?: ParseOptions): ParseResult {
  const limits = resolveLimits(options?.limits);
  const normalized = normalize(input, limits);
  if (normalized.diagnostics.length > 0) {
    return {
      ok: false,
      value: undefined,
      version: 1,
      tree: unreadable(),
      diagnostics: normalized.diagnostics,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const { tree, version } = parseDocument(normalized.text, limits, diagnostics);
  // The lexer and the parser report as they go, so order the list by where each fault is.
  diagnostics.sort((a, b) => a.start.offset - b.start.offset);
  const ok = !diagnostics.some((d) => d.severity === "error");
  return { ok, value: ok ? toValue(tree) : undefined, version, tree, diagnostics };
}

/** Parses a document and returns its value, or throws an XferError carrying the diagnostics. */
export function parseValue(input: string | Uint8Array, options?: ParseOptions): XferValue {
  const result = parse(input, options);
  if (!result.ok || result.value === undefined) {
    throw new XferError(result.diagnostics);
  }
  return result.value;
}
