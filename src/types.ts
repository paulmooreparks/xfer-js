// The data types of the public API. DESIGN.md section 3 is the reference; keep the two in step.

export interface Position {
  /** UTF-8 byte offset into the normalized text, 0-based. */
  readonly offset: number;
  /** Line, 1-based. */
  readonly line: number;
  /** Column, 1-based, counted in scalar values. */
  readonly column: number;
}

export type Severity = "error" | "warning" | "info";

import type { DiagnosticCode } from "./diagnostics";

export type { DiagnosticCode };

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly message: string;
  readonly start: Position;
  /** Exclusive. Equals start for a point diagnostic. */
  readonly end: Position;
}

export interface Limits {
  readonly documentBytes: number;
  readonly depth: number;
  readonly tokenBytes: number;
  readonly runLength: number;
  readonly elements: number;
}

export interface ParseOptions {
  /** Each limit defaults to the specification's minimum; a caller may raise or lower it. */
  readonly limits?: Partial<Limits>;
}

// Value model.

export interface Annotation {
  readonly name: string;
  readonly value: XferValue;
}

interface Base {
  /** Absent, not empty, when there are none. */
  readonly annotations?: readonly Annotation[];
}

export interface XferObject extends Base {
  readonly kind: "object";
  readonly entries: ReadonlyMap<string, XferValue>;
}

export interface XferSequence extends Base {
  readonly kind: "sequence";
  readonly items: readonly XferValue[];
}

export interface XferString extends Base {
  readonly kind: "string";
  readonly value: string;
}

export interface XferInteger extends Base {
  readonly kind: "integer";
  readonly value: bigint;
  readonly lexeme: string;
}

/** Keeps only the lexeme. Includes the special values "inf", "-inf" and "nan". */
export interface XferFractional extends Base {
  readonly kind: "fractional";
  readonly lexeme: string;
}

export interface XferBool extends Base {
  readonly kind: "bool";
  readonly value: boolean;
}

export interface XferNull extends Base {
  readonly kind: "null";
}

export interface XferSymbol extends Base {
  readonly kind: "symbol";
  readonly name: string;
}

export interface XferTemporal extends Base {
  readonly kind: "date" | "time" | "local-datetime" | "datetime";
  readonly lexeme: string;
}

export type XferValue =
  | XferObject
  | XferSequence
  | XferString
  | XferInteger
  | XferFractional
  | XferBool
  | XferNull
  | XferSymbol
  | XferTemporal;

// Lossless tree.

export type TokenKind =
  | "lbrace"
  | "rbrace"
  | "lbrack"
  | "rbrack"
  | "annot-open"
  | "annot-close"
  | "string"
  | "integer"
  | "fractional"
  | "date"
  | "time"
  | "local-datetime"
  | "datetime"
  | "keyword"
  | "identifier"
  | "error"
  | "eof";

export interface Trivia {
  readonly kind: "whitespace" | "comment";
  readonly start: Position;
  readonly end: Position;
  readonly text: string;
  /** Comments only: the length of the slash run. */
  readonly run?: number;
}

export interface Token {
  readonly kind: TokenKind;
  readonly start: Position;
  /** Exclusive. */
  readonly end: Position;
  /** The exact source slice, delimiters included. */
  readonly text: string;
  /** Whitespace and comments before this token, in order. */
  readonly leading: readonly Trivia[];
  /** Strings only: the content between the delimiters, uninterpreted. */
  readonly content?: string;
  readonly delimiter?: { readonly form: "rep" | "hash"; readonly run: number };
  readonly keyword?: "true" | "false" | "null" | "inf" | "-inf" | "nan";
}

export interface AnnotationNode {
  readonly open: Token;
  /** Absent only in a malformed annotation that has no name. */
  readonly name: Token | undefined;
  readonly value: Node | undefined;
  /** Absent only in a malformed annotation that is never closed. */
  readonly close: Token | undefined;
}

export interface PairNode {
  /**
   * Absent only when annotations were left with no key to attach to, or when a bracket stood
   * where a key belongs. Both have a diagnostic.
   */
  readonly key: Token | undefined;
  readonly value: Node | undefined;
  readonly annotations: readonly AnnotationNode[];
  /**
   * What stood between the key and the value and belongs to neither, in source order: stray
   * separators (a `,` or `:` carried over from another format) and annotations placed after the
   * key. Each has a diagnostic; they are kept so the tree stays lossless.
   */
  readonly skipped: readonly (Token | AnnotationNode)[];
}

export type Node =
  | {
      readonly kind: "object";
      readonly open: Token;
      readonly close: Token | undefined;
      readonly pairs: readonly PairNode[];
      readonly annotations: readonly AnnotationNode[];
    }
  | {
      readonly kind: "sequence";
      readonly open: Token;
      readonly close: Token | undefined;
      readonly items: readonly Node[];
      readonly annotations: readonly AnnotationNode[];
    }
  | {
      readonly kind: "scalar";
      readonly token: Token;
      readonly annotations: readonly AnnotationNode[];
    }
  | {
      readonly kind: "error";
      readonly tokens: readonly Token[];
      readonly annotations: readonly AnnotationNode[];
    };

export interface Document {
  /** The xfer head annotation, when the source had one. */
  readonly head: AnnotationNode | undefined;
  readonly root: Node | undefined;
  /** Tokens after the root element, kept so the tree stays lossless. Non-empty only with XFER0402. */
  readonly trailing: readonly Token[];
  /** Its leading trivia is the document's trailing trivia. */
  readonly eof: Token;
  /** The normalized text. */
  readonly text: string;
}

export interface ParseResult {
  /** No diagnostic of severity "error". */
  readonly ok: boolean;
  /** Present exactly when ok. */
  readonly value: XferValue | undefined;
  /** From the xfer head, or 1. */
  readonly version: number;
  readonly tree: Document;
  readonly diagnostics: readonly Diagnostic[];
}

// Options for the writers.

export interface CanonicalOptions {
  readonly limits?: Partial<Limits>;
}

export interface FromJsonOptions {
  /** Only `depth` applies. Each limit defaults to the specification's minimum. */
  readonly limits?: Partial<Limits>;
}

export interface ToJsonOptions {
  readonly stringifyBigInts?: boolean;
  readonly indent?: number;
  /**
   * Only `documentBytes` applies: JSON text longer than it, counted in UTF-16 code units as the
   * canonical writer counts, is refused with XFER0601 (specification 8.1). Defaults to the
   * specification's minimum.
   */
  readonly limits?: Partial<Limits>;
}

export interface PlainOptions {
  readonly integers?: "number-when-safe" | "bigint";
  /**
   * "number" (the default) gives the nearest double, which is lossy for a lexeme with more
   * precision than a double holds or outside its range (`1e400` becomes Infinity); use
   * `asNumber` to learn whether a value was exact. "lexeme" keeps the source spelling as a string.
   */
  readonly fractionals?: "number" | "lexeme";
  readonly symbols?: "string" | "symbol-object";
}
