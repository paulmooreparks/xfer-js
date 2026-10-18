import type { Diagnostic } from "./types";

/** Thrown when a value cannot be produced from a parse, carrying every diagnostic the parse produced. */
export class XferError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  /** `message` is for an error with no diagnostics to describe it. */
  constructor(diagnostics: readonly Diagnostic[], message?: string) {
    const first = diagnostics.find((d) => d.severity === "error") ?? diagnostics[0];
    const more = diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : "";
    super(
      first !== undefined
        ? `${first.code} at ${first.start.line}:${first.start.column}: ${first.message}${more}`
        : (message ?? "invalid XferLang"),
    );
    this.name = "XferError";
    this.diagnostics = diagnostics;
  }
}
