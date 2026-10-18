import type { Diagnostic, Position, Severity } from "./types";

interface DiagnosticInfo {
  readonly severity: Severity;
  readonly summary: string;
}

// Transcribed from the table in the specification, section 10. test/diagnostics.test.ts compares
// it with the specification text, so a change to one without the other fails the build.
export const DIAGNOSTICS = {
  XFER0101: { severity: "error", summary: "scalar token not followed by a separator" },
  XFER0102: { severity: "error", summary: "`<` not followed by `/` or `!`" },
  XFER0103: { severity: "error", summary: "character cannot begin a token" },
  XFER0104: { severity: "error", summary: "unterminated comment" },
  XFER0105: { severity: "error", summary: "identifier ends with `.`" },
  XFER0201: { severity: "error", summary: "unterminated string" },
  XFER0202: { severity: "error", summary: '`#` not followed by `#` or `"`' },
  XFER0301: { severity: "error", summary: "leading zero on a decimal integer" },
  XFER0302: { severity: "error", summary: "malformed number" },
  XFER0303: {
    severity: "error",
    summary: "number out of range for the requested type (conversion, not parsing)",
  },
  XFER0304: { severity: "error", summary: "malformed temporal" },
  XFER0305: { severity: "error", summary: "temporal denotes no valid instant" },
  XFER0401: { severity: "error", summary: "document has no element" },
  XFER0402: { severity: "error", summary: "content after the root element" },
  XFER0403: { severity: "error", summary: "duplicate key" },
  XFER0404: { severity: "error", summary: "object body has a key without a value" },
  XFER0405: { severity: "error", summary: "unterminated object or sequence" },
  XFER0406: { severity: "error", summary: "unexpected closing bracket" },
  XFER0407: { severity: "error", summary: "token in key position is not an identifier or string" },
  XFER0501: { severity: "error", summary: "annotation value carries an annotation" },
  XFER0502: { severity: "error", summary: "annotation has no target" },
  XFER0503: { severity: "error", summary: "`xfer` annotation is not the first token" },
  XFER0504: { severity: "error", summary: "unsupported major version" },
  XFER0505: { severity: "error", summary: "duplicate `id`" },
  XFER0506: { severity: "error", summary: "unknown annotation" },
  XFER0601: { severity: "error", summary: "document exceeds size limit" },
  XFER0602: { severity: "error", summary: "nesting exceeds depth limit" },
  XFER0603: { severity: "error", summary: "scalar token exceeds length limit" },
  XFER0604: { severity: "error", summary: "delimiter run exceeds length limit" },
  XFER0605: { severity: "error", summary: "element count exceeds limit" },
  XFER0701: { severity: "error", summary: "invalid UTF-8" },
  XFER0901: { severity: "warning", summary: "integer outside JSON's safe range" },
  XFER0902: { severity: "error", summary: "special float has no JSON mapping" },
  XFER0903: { severity: "info", summary: "symbol mapped to JSON string" },
  XFER0904: { severity: "info", summary: "temporal mapped to JSON string" },
  XFER0905: { severity: "warning", summary: "duplicate key in JSON source; last value kept" },
} as const satisfies Record<string, DiagnosticInfo>;

export type DiagnosticCode = keyof typeof DIAGNOSTICS;

/**
 * Builds a diagnostic. The message is the code's summary, followed by `: detail` when the caller
 * has specifics to add. `end` defaults to `start`, which makes a point diagnostic.
 */
export function makeDiagnostic(
  code: DiagnosticCode,
  start: Position,
  end: Position = start,
  detail?: string,
): Diagnostic {
  const info: DiagnosticInfo = DIAGNOSTICS[code];
  const message = detail === undefined ? info.summary : `${info.summary}: ${detail}`;
  return { code, severity: info.severity, message, start, end };
}
