import type { Diagnostic } from "./types";

/** Thrown by `parseValue`, carrying every diagnostic the parse produced. */
export class XferError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const first = diagnostics.find((d) => d.severity === "error") ?? diagnostics[0];
    const more = diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : "";
    super(
      first === undefined
        ? "invalid XferLang"
        : `${first.code} at ${first.start.line}:${first.start.column}: ${first.message}${more}`,
    );
    this.name = "XferError";
    this.diagnostics = diagnostics;
  }
}
