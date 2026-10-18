// The core runs in Node, browsers, Deno and Bun, so it may use only what every one of them
// provides. tsconfig.json compiles src with no ambient type libraries (no DOM, no Node), and
// these are the only runtime globals the core is allowed. Using anything else from the
// environment is a compile error, which is how DESIGN.md section 1, item 2 is enforced.

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
