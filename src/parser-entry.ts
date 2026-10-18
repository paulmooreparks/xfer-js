import type { ParseOptions, ParseResult, XferValue } from "./types";

export function parse(_input: string | Uint8Array, _options?: ParseOptions): ParseResult {
  throw new Error("not implemented");
}

export function parseValue(_input: string | Uint8Array, _options?: ParseOptions): XferValue {
  throw new Error("not implemented");
}
