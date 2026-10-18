# xfer-js: implementation design

The JavaScript implementation of XferLang 1.0, published to npm as `xferlang`. This document is written so that an engineer or an agent can implement the package from it without further design decisions. Read `../xferlang/spec/xferlang.md` first; this document does not restate the language, it says how to build it in TypeScript. Where this document pins something the specification leaves open, section 12 lists it so the specification can be updated in the same change.

Written 2026-10-18. Decisions made during implementation are recorded in section 16.

## 1. Non-negotiables

1. **Zero runtime dependencies.** `package.json` has no `dependencies`. Dev dependencies are pinned.
2. **The core imports nothing from Node.** No `fs`, `path`, `process`, `Buffer`, `node:*`. The core uses only `TextEncoder`, `TextDecoder`, `Map`, `BigInt` and plain language features, all of which exist in Node 18+, every current browser, Deno and Bun. The CLI (`cli/`) is the only place Node APIs appear.
3. **The core never throws for input content.** `parse()` returns diagnostics. The only function that throws on input is `parseValue()`, and it throws `XferError` carrying the same diagnostics. Programming errors (wrong argument types) may throw `TypeError`.
4. **No recursion on input-controlled depth.** The parser, the canonical writer, `toJson`, `fromJson`, `toPlain` and the tagged-value test helper all use explicit stacks. The depth limit is a diagnostic, not a guard against stack overflow.
5. **Strings are verbatim.** No code path ever interprets a backslash or any other character inside a string literal.
6. **The suite is the oracle.** A test that passes by special-casing a suite file is a defect. When the suite and this implementation disagree, section 11 says what to do.
7. **Identical behaviour on every surface.** The CLI, the browser, Deno and Bun all call the same functions with the same options; nothing is surface-specific except I/O.

## 2. Repository layout

```
xfer-js/
  package.json
  tsconfig.json                 src only, no ambient type libraries (enforces non-negotiable 2)
  tsconfig.node.json            cli, test and root configs, with Node types
  tsdown.config.ts
  biome.json
  vitest.config.ts
  .changeset/
  .github/workflows/ci.yml
  .github/workflows/release.yml
  LICENSE                       MIT
  README.md
  SECURITY.md
  CHANGELOG.md                  maintained by changesets
  suite/                        git submodule: https://github.com/paulmooreparks/xferlang
  src/
    index.ts                    public API re-exports only
    types.ts                    XferValue, Annotation, Document/Node/Token, Diagnostic, options
    diagnostics.ts              codes table, severities, messages, Diagnostic factory
    limits.ts                   LIMIT_MINIMUMS, resolveLimits()
    unicode.ts                  identifier start/continue predicates, excluded ranges, UTF-8 length
    normalize.ts                decode + validate UTF-8, strip BOM, CR/CRLF -> LF
    lexer.ts                    Lexer: normalized text -> tokens + trivia + diagnostics
    parser.ts                   Parser: tokens -> Document (lossless tree) + diagnostics
    value.ts                    Document -> XferValue; asNumber, asDecimal, asTemporal helpers
    canonical.ts                XferValue | Document -> canonical text
    strings.ts                  chooseDelimiter(), writeString(); shared by canonical and CLI
    json/
      read.ts                   JSON text -> XferValue (own reader; keeps lexemes, sees duplicates)
      write.ts                  XferValue -> JSON text
    plain.ts                    XferValue -> ordinary JavaScript values
    error.ts                    XferError
  cli/
    main.ts                     argument parsing, exit codes, I/O; imports from ../src
  test/
    txtar.ts                    archive reader
    tagged.ts                   XferValue -> tagged JSON (the suite's value form)
    conformance.test.ts         generated from suite/tests
    bytes.test.ts               generated from suite/tests/bytes
    property.test.ts            embedding and whitespace invariants (fast-check)
    api.test.ts                 options, errors, helpers
    cli.test.ts                 spawns the built CLI
```

## 3. Public API (`src/index.ts`)

Everything exported is listed here. Nothing else is public.

```ts
export { parse, parseValue } from "./parser-entry";
export { canonical } from "./canonical";
export { toJson } from "./json/write";
export { fromJson } from "./json/read";
export { toPlain } from "./plain";
export { asNumber, asDecimal, asTemporal } from "./value";
export { XferError } from "./error";
export { DIAGNOSTICS } from "./diagnostics";
export { LIMIT_MINIMUMS } from "./limits";
export type {
  XferValue, XferObject, XferSequence, XferString, XferInteger, XferFractional,
  XferBool, XferNull, XferSymbol, XferTemporal, Annotation,
  Document, Node, Token, TokenKind, Trivia,
  Diagnostic, DiagnosticCode, Severity,
  ParseOptions, ParseResult, Limits, CanonicalOptions, ToJsonOptions, PlainOptions,
} from "./types";
```

### 3.1 Parsing

```ts
export interface Limits {
  readonly documentBytes: number;   // default 2**28 - 1
  readonly depth: number;           // default 256
  readonly tokenBytes: number;      // default 2**28 - 1
  readonly runLength: number;       // default 64
  readonly elements: number;        // default 2**31 - 1
}
export interface ParseOptions {
  readonly limits?: Partial<Limits>;   // values below the minimums are raised to the minimums
}
export interface ParseResult {
  readonly ok: boolean;                       // no diagnostic of severity "error"
  readonly value: XferValue | undefined;      // present iff ok
  readonly version: number;                   // from the xfer head, or 1
  readonly tree: Document;                    // always present; may contain error nodes
  readonly diagnostics: readonly Diagnostic[];
}
export function parse(input: string | Uint8Array, options?: ParseOptions): ParseResult;
export function parseValue(input: string | Uint8Array, options?: ParseOptions): XferValue; // throws XferError
```

`parse` never throws for any `input` content. `value` is `undefined` whenever any error-severity diagnostic exists, even if a partial tree was built; consumers who want partial data read `tree`.

### 3.2 Value model (`src/types.ts`)

```ts
export interface Annotation { readonly name: string; readonly value: XferValue; }
interface Base { readonly annotations?: readonly Annotation[]; }   // absent when none

export interface XferObject    extends Base { readonly kind: "object";    readonly entries: ReadonlyMap<string, XferValue>; }
export interface XferSequence  extends Base { readonly kind: "sequence";  readonly items: readonly XferValue[]; }
export interface XferString    extends Base { readonly kind: "string";    readonly value: string; }
export interface XferInteger   extends Base { readonly kind: "integer";   readonly value: bigint; readonly lexeme: string; }
export interface XferFractional extends Base { readonly kind: "fractional"; readonly lexeme: string; }  // includes "inf" "-inf" "nan"
export interface XferBool      extends Base { readonly kind: "bool";      readonly value: boolean; }
export interface XferNull      extends Base { readonly kind: "null"; }
export interface XferSymbol    extends Base { readonly kind: "symbol";    readonly name: string; }
export interface XferTemporal  extends Base {
  readonly kind: "date" | "time" | "local-datetime" | "datetime";
  readonly lexeme: string;
}
export type XferValue = XferObject | XferSequence | XferString | XferInteger | XferFractional
                      | XferBool | XferNull | XferSymbol | XferTemporal;
```

- Objects use `Map` because the spec makes key order normative and `Map` preserves insertion order for every key, including `__proto__` and numeric-looking keys, which plain objects do not.
- `XferInteger.value` is exact at any size. `lexeme` is the source spelling, used by the canonical writer.
- Fractionals keep only the lexeme. The package never decides float versus decimal.
- `annotations` is omitted (not an empty array) when there are none, so structural equality in tests is simple.

Helpers (`src/value.ts`):

```ts
export function asNumber(v: XferInteger | XferFractional): { value: number; exact: boolean };
// integer: exact iff |value| <= 2**53-1. fractional: Number(lexeme without "_"); exact iff the
// decimal expansion of the result equals the lexeme's value (compare via asDecimal of both).
export function asDecimal(v: XferFractional): { digits: bigint; exponent: number } | undefined;
// 1.50 -> {digits: 150n, exponent: -2}; 6.02e23 -> {digits: 602n, exponent: 21}; undefined for inf/-inf/nan.
export function asTemporal(v: XferTemporal): unknown | undefined;
// Returns a Temporal.PlainDate / PlainTime / PlainDateTime / Instant-with-offset (ZonedDateTime is wrong: no zone)
// when globalThis.Temporal exists, else undefined. Never polyfills.
```

### 3.3 Lossless tree (`src/types.ts`)

```ts
export interface Position { readonly offset: number; readonly line: number; readonly column: number; }
// offset: UTF-8 byte offset into the normalized text, 0-based. line, column: 1-based; column counts scalar values.

export type TokenKind =
  | "lbrace" | "rbrace" | "lbrack" | "rbrack" | "annot-open" | "annot-close"
  | "string" | "integer" | "fractional" | "date" | "time" | "local-datetime" | "datetime"
  | "keyword" | "identifier" | "error" | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly start: Position;
  readonly end: Position;           // exclusive
  readonly text: string;            // exact source slice, delimiters included
  readonly leading: readonly Trivia[];   // whitespace and comments before this token
  // kind-specific:
  readonly content?: string;        // string: decoded content (a slice; no interpretation)
  readonly delimiter?: { readonly form: "rep" | "hash"; readonly run: number };
  readonly keyword?: "true" | "false" | "null" | "inf" | "-inf" | "nan";
}
export interface Trivia {
  readonly kind: "whitespace" | "comment";
  readonly start: Position; readonly end: Position; readonly text: string;
  readonly run?: number;            // comment: the slash run length
}

export type Node =
  | { readonly kind: "object";   readonly open: Token; readonly close: Token | undefined; readonly pairs: readonly PairNode[]; readonly annotations: readonly AnnotationNode[] }
  | { readonly kind: "sequence"; readonly open: Token; readonly close: Token | undefined; readonly items: readonly Node[]; readonly annotations: readonly AnnotationNode[] }
  | { readonly kind: "scalar";   readonly token: Token; readonly annotations: readonly AnnotationNode[] }
  | { readonly kind: "error";    readonly tokens: readonly Token[]; readonly annotations: readonly AnnotationNode[] };
export interface PairNode { readonly key: Token; readonly value: Node | undefined; readonly annotations: readonly AnnotationNode[]; }
export interface AnnotationNode { readonly open: Token; readonly name: Token; readonly value: Node | undefined; readonly close: Token | undefined; }
export interface Document {
  readonly head: AnnotationNode | undefined;   // the xfer head
  readonly root: Node | undefined;
  readonly eof: Token;                         // its leading trivia is the document's trailing trivia
  readonly text: string;                       // the normalized text
}
```

Every byte of the normalized text is reachable: each token's `leading` trivia plus its `text`, in order, concatenated over the token stream (ending with `eof`), reproduces `Document.text` exactly. `test/api.test.ts` asserts this for every suite document.

### 3.4 Diagnostics

```ts
export type Severity = "error" | "warning" | "info";
export type DiagnosticCode = keyof typeof DIAGNOSTICS;   // "XFER0101" | ...
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly message: string;        // English, one sentence, no trailing period, may include specifics
  readonly start: Position;
  readonly end: Position;          // exclusive; equals start for a point diagnostic
}
export const DIAGNOSTICS: Readonly<Record<string, { severity: Severity; summary: string }>>;
```

`DIAGNOSTICS` is the table in spec section 10, transcribed. Messages are built from the summary plus specifics (for example `XFER0404` lists the inferred pairings, as the spec requires).

### 3.5 Writing and mapping

```ts
export interface CanonicalOptions { readonly limits?: Partial<Limits>; }  // runLength affects the choice rule
export function canonical(input: XferValue | Document, options?: CanonicalOptions): string;
// For a Document: uses tree.root and tree.head; error nodes throw XferError (canonical form of an invalid document is undefined).

export interface ToJsonOptions { readonly stringifyBigInts?: boolean; readonly indent?: number; }
export function toJson(value: XferValue, options?: ToJsonOptions): { readonly text: string; readonly diagnostics: readonly Diagnostic[] };
// Returns JSON text, not a JS value, so integers beyond 2**53 are written at full precision.

export function fromJson(text: string): { readonly value: XferValue | undefined; readonly diagnostics: readonly Diagnostic[] };
// Own JSON reader (section 8). Malformed JSON -> XFER0906 (see section 12). Duplicate keys -> XFER0905, last wins.

export interface PlainOptions { readonly integers?: "number-when-safe" | "bigint" ; readonly symbols?: "string" | "symbol-object"; }
export function toPlain(value: XferValue, options?: PlainOptions): unknown;
// object -> {} (keys in order; a key "__proto__" is set with Object.defineProperty), sequence -> [], string -> string,
// integer -> number when |v| <= 2**53-1 else bigint (default) or always bigint, fractional -> Number(lexeme),
// bool, null, symbol -> string (default) or the XferSymbol object, temporal -> lexeme string. Annotations dropped.
```

## 4. Normalization (`src/normalize.ts`)

```ts
export interface Normalized { readonly text: string; readonly diagnostics: Diagnostic[]; readonly inputBytes: number; }
export function normalize(input: string | Uint8Array, limits: Limits): Normalized;
```

1. If `input` is `Uint8Array`: if `input.length > limits.documentBytes`, emit `XFER0601` at offset 0 and return with empty text. Decode with `new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })`. On `TypeError`, emit `XFER0701` at offset 0 and return with empty text. (Position of the first bad byte is not available from `TextDecoder`; a point diagnostic at 0 is acceptable; the suite uses `*` for these cases.) `ignoreBOM: false` makes the decoder strip a leading BOM.
2. If `input` is `string`: if it contains a lone surrogate (scan with a regex `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/`), emit `XFER0701` at the scalar-value offset of the first one. Strip a leading U+FEFF. Compute the UTF-8 byte length; if it exceeds `limits.documentBytes`, `XFER0601`.
3. Replace `\r\n` with `\n`, then remaining `\r` with `\n`.
4. Return the text. All positions reported by the lexer and parser are positions in this normalized text (section 12, item 1).

## 5. Lexer (`src/lexer.ts`)

```ts
export class Lexer {
  constructor(text: string, limits: Limits, diagnostics: Diagnostic[]);
  next(): Token;          // returns "eof" repeatedly at end; never throws
}
```

The lexer walks the string by code point (`codePointAt`, advancing 1 or 2 UTF-16 units) and maintains `index` (UTF-16), `offset` (UTF-8 bytes, computed from each code point: 1 for < 0x80, 2 for < 0x800, 3 for < 0x10000, else 4), `line` and `column` (scalar values, reset to 1 after `\n`). Every token and trivia records start and end positions.

### 5.1 Trivia

Before each token, collect trivia in order:

- Whitespace: a maximal run of U+0020, U+0009, U+000A, U+000C.
- Comment: `<` followed by one or more `/`. Let `n` be the slash run (count all consecutive slashes). If `n > limits.runLength`, emit `XFER0604` at the comment start and continue reading the comment normally. Then scan forward: at each `/`, measure the maximal slash run `r`; if `r === n` and the character after the run is `>`, the comment ends after `>`; otherwise continue scanning from after the run. If end of text is reached, emit `XFER0104` at the comment start and the comment extends to end of text.

Trivia is attached as `leading` to the next token (or to `eof`).

### 5.2 Dispatch

After trivia, dispatch on the current code point:

| Current | Token |
|---|---|
| end of text | `eof` |
| `{` `}` `[` `]` | the bracket, one character |
| `<` then `!` | `annot-open`, two characters |
| `<` then anything else (`/` was consumed as trivia) | `XFER0102` at `<`; emit an `error` token of one character |
| `!` then `>` | `annot-close`, two characters |
| `"` | repetition string (5.3) |
| `#` | hash string (5.4) |
| `0`..`9` | number or temporal (5.5) |
| `-` | `-inf`, or a negative number (5.5) |
| ASCII letter, `_`, admitted non-ASCII | identifier or keyword (5.6) |
| anything else | `XFER0103` at the character; emit an `error` token; skip to the next terminator (5.7) |

### 5.3 Repetition string

1. Count the opening run `n` of consecutive `"`. If `n > limits.runLength`: `XFER0604` at the token start, then continue reading the string normally (finding its closer of exactly `n` is linear, and gives better recovery than consuming the rest of the document).
2. **The empty string:** if `n === 2`, the token is the empty string, length 2, whatever follows; the separation check then applies, so `""x""` reports `XFER0101` at `x`. (Paul's ruling, 2026-10-18; see section 16.)
3. Otherwise scan forward from after the opening run. At each `"`, measure the maximal run `r`. If `r === n`, the string ends after that run; content is the text between the runs. If `r !== n`, continue from after the run (those quotes are content). At end of text: `XFER0201` at the token start; the token's content is everything after the opener and the token ends at end of text (recovery: the rest of the document is consumed, as the spec allows).
4. `delimiter = { form: "rep", run: n }`; `content` is a slice (no copying beyond `substring`).
5. If the content's byte length exceeds `limits.tokenBytes`: `XFER0603`.

### 5.4 Hash string

1. Count the hash run `m`. If `m > limits.runLength`: `XFER0604`. If the next character is not `"`: `XFER0202` at the first `#`; emit an `error` token covering the hashes; continue lexing at the character after them.
2. Scan forward from after the `"`. At each `"`, count the hashes `r` that immediately follow (maximal run). If `r === m`, the string ends after those hashes. Otherwise continue from after the hash run. End of text: `XFER0201` at token start.
3. `delimiter = { form: "hash", run: m }`.

### 5.5 Numbers and temporals

A hand-written scanner, grammar-driven, never a regex over a "scalar run", because the separation rule requires a token to end where its grammar ends (so `1-2` is `1` followed by a separation error at `-`, and `2025-08-01t09:30:00` is a date followed by a separation error at `t`).

Let `s` be the token start. Steps:

1. If the current character is `-`: consume it and note that the token is signed. If the next three characters are `inf`, the token is the keyword `-inf`, and the separation check follows, so `-infinity` reports `XFER0101` at its second `i`. Otherwise, if the next character is not a digit, emit `XFER0302` at `s` and recover (5.7).
2. If the current character is `0` and the next is `x`, `o` or `b`: consume both; scan digits of that radix with the underscore rule (an `_` must be preceded and followed by a digit of the radix). At least one digit is required. Any violation: `XFER0302` at `s`, recover. Result: `integer`. If the next is `X`, `O` or `B`, emit `XFER0302` at `s` and recover: an uppercase radix prefix is a malformed number, not `0` followed by a separation error.
3. Otherwise scan a decimal digit run with the underscore rule. Let `d` be the digits (without underscores) and `u` whether any underscore appeared.
   - The temporal checks come first, before the leading-zero rule, because a year (`0001`) or an hour (`09`) may begin with `0`; and they apply only when no sign was consumed, because a temporal takes no sign (`-2025-08-01` is the integer `-2025` and a separation error).
   - If the next character is `-` and `d.length === 4` and `!u`: this is a date. Require `-` `DD` `-` `DD` exactly (two digits each). Then, if the next character is `T`: require `HH:MM:SS`, optionally `.` followed by one or more digits, optionally `Z` or `+HH:MM` or `-HH:MM`. Any shape violation: `XFER0304` at `s`, recover. Then validate ranges (5.5.1): violation is `XFER0305` at `s` (the token is still produced, as an `error` token). Kind: `date`, `local-datetime` (no offset) or `datetime` (offset).
   - If the next character is `:` and `d.length === 2` and `!u`: this is a time. Require `:MM:SS` then optional fraction. Violation: `XFER0304`. Validate ranges. Kind: `time`.
   - Otherwise, if `d` has length > 1 and starts with `0`: `XFER0301` at `s`, recover.
   - If the next character is `.`: require at least one digit after it (underscore rule applies within the fraction digits); else `XFER0302`. Then optional exponent. Kind: `fractional`.
   - If the next character is `e` or `E`: optional `+` or `-`, then at least one digit (underscore rule). Else `XFER0302`. Kind: `fractional`.
   - Otherwise kind: `integer`.
4. The token ends here. The separation check (5.7) follows.

The integer token's `text` is the lexeme; the parser computes `value` with `BigInt` after removing underscores and handling the radix prefix (`BigInt("0x1f")` works; for the negative case apply the sign separately).

#### 5.5.1 Temporal range validation

Year 0000 to 9999 (any four digits); month 01 to 12; day 01 to the month's length, with February 29 only in leap years (divisible by 4, except centuries not divisible by 400); hour 00 to 23; minute 00 to 59; second 00 to 60 (60 permits a leap second, as RFC 3339 does; section 12, item 3); offset hour 00 to 23 and minute 00 to 59. The fraction may have any number of digits.

### 5.6 Identifiers and keywords

1. The start character is an ASCII letter, `_`, or an admitted non-ASCII scalar value (section 6). Consume continuation characters: ASCII letters, digits, `_`, `-`, `.`, admitted non-ASCII.
2. If the last character consumed is `.`: `XFER0105` at the token start. The token is still an `identifier` (so the parser can continue) but is marked by the diagnostic.
3. If the text is exactly `true`, `false`, `null`, `inf` or `nan`: kind `keyword` with the `keyword` field set. Otherwise kind `identifier`.
4. Separation check follows.

### 5.7 Separation check and recovery

A **terminator** is: end of text; U+0020, U+0009, U+000A, U+000C; `{`, `}`, `[`, `]`; `<`; or `!` immediately followed by `>`.

After every scalar token (string, number, temporal, keyword, identifier), if the next character is not a terminator, emit `XFER0101` at that character's position. Then **recover** by skipping characters until a terminator, without emitting further diagnostics for them. The skipped text becomes an `error` token so the tree stays lossless.

**Recovery after a malformed number, temporal or hash opener** (`XFER0301`, `XFER0302`, `XFER0304`, `XFER0202`): skip to the next terminator the same way; the whole skipped span is one `error` token starting at `s`.

`XFER0603` (token length) is checked against the UTF-8 byte length of every token's `text`.

## 6. Unicode (`src/unicode.ts`)

```ts
export function isIdentifierStart(cp: number): boolean;     // ASCII letter, "_", or admitted non-ASCII
export function isIdentifierContinue(cp: number): boolean;  // start chars, ASCII digit, "-", "."
export function isAdmittedNonAscii(cp: number): boolean;    // cp >= 0x80 and not excluded
export function utf8Length(cp: number): 1 | 2 | 3 | 4;
```

Excluded (spec 4.3): U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF; U+200B to U+200F, U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069. Implement as a sorted array of `[lo, hi]` pairs and a linear scan (thirteen ranges, kept unmerged as the specification lists them; no table generation, no Unicode version dependency). Surrogate code points cannot occur after normalization.

## 7. Parser (`src/parser.ts`)

```ts
export function parseDocument(text: string, limits: Limits, diagnostics: Diagnostic[]): { tree: Document; version: number };
```

An iterative parser with an explicit stack. Each stack frame is an open container: `{ node: object|sequence under construction, open: Token, pendingAnnotations: AnnotationNode[], pendingKey?: Token, pendingPairAnnotations?: AnnotationNode[] }`. Depth is the stack length; opening a container when `stack.length === limits.depth` emits `XFER0602` at the bracket and the bracket is recorded as an `error` node and skipped (its contents are then parsed at the same depth, which is wrong but bounded; the document is already invalid).

### 7.1 Document

1. Read the first token. If it is `annot-open`, look ahead: if the annotation's name token is the identifier `xfer`, this is the head. The head is valid only if the `annot-open` token has **no leading comment trivia** and starts at offset 0 after whitespace... Correction, per spec 7: the head must be the first token of the document, so its `annot-open` must have no comment in its leading trivia (whitespace is permitted; section 12, item 4 asks the spec to say so). Parse the annotation (7.3). Its value must be an `integer` token with a plain decimal lexeme (no radix, no `_`, no sign); otherwise `XFER0504` at the `annot-open`. If the value is not `1`: `XFER0504`. Record `version`.
2. Parse one element (7.2). If the first token is `eof`: `XFER0401` at the eof position; `root` is `undefined`.
3. After the element, the next token must be `eof`; otherwise `XFER0402` at that token, and the rest of the tokens are consumed into an `error` node so the tree stays lossless.

### 7.2 Elements, containers, pairs

Driven by the stack:

- **At a value position** (document root, sequence item, or after a key): collect zero or more annotations (7.3) into `pending`. Then:
  - `lbrace` / `lbrack`: push a frame with `pending` as the container's annotations.
  - a scalar token: produce a scalar node with `pending`.
  - `rbrace` / `rbrack` / `eof` / `annot-close` while `pending` is non-empty: `XFER0502` at the first pending annotation's `annot-open`. Then handle the token as below.
  - `error` token: produce an error node.
- **In a sequence frame:** `rbrack` closes it. `rbrace`: `XFER0406` at the token; consume it as an error node and continue in the same frame. `eof`: `XFER0405` at the frame's `open` token; close the frame with `close: undefined`.
- **In an object frame, expecting a key:** `rbrace` closes it. `identifier` → key (a trailing-dot identifier was already diagnosed by the lexer and is accepted as a key). `string` → key (its `content` is the key text). `keyword`, `integer`, `fractional`, any temporal → `XFER0407` at the token; treat the token as the key anyway so the value that follows is consumed and the shift is contained. `lbrace`/`lbrack`/scalar where a key is expected but the previous pair has no value is not reachable (see next bullet). `rbrack`: `XFER0406`, consume. `eof`: `XFER0405` at `open`.
- **In an object frame, expecting a value** (after a key): if the next token is `rbrace` or `eof`: `XFER0404` at the key token; the pair is recorded with `value: undefined`; then handle the token as a close or unterminated. Otherwise parse the value as at a value position.
- **Duplicate keys:** when a pair completes, compare its key text (identifier text, or string content) with the frame's `Set` of keys; on a repeat emit `XFER0403` at the repeated key token. Both pairs stay in the tree; the value model keeps the last (section 12, item 5).
- **Element count:** every node produced increments a counter; exceeding `limits.elements` emits `XFER0605` once and parsing continues.

The `XFER0404` message must list the pairings the parser inferred in that object, as `key=value-kind` pairs (for example `a=symbol b, c=symbol d, e=symbol f, g=?`), because the spec requires it and because it is the only way a reader finds a shifted pair.

### 7.3 Annotations

On `annot-open`:
1. The next token must be an `identifier` (name). If it is `eof` or anything else: `XFER0506` at `annot-open` with a message that the name is missing; recover by consuming tokens up to and including the next `annot-close` or to `eof`.
2. Parse exactly one value as at a value position, but with annotations **disallowed**: if an `annot-open` is seen where the value should start, emit `XFER0501` at that inner `annot-open`, then parse the inner annotation and discard it, then parse the value. Containers inside an annotation value are parsed with the same stack machinery (push a frame flagged `inAnnotation`), and an `annot-open` encountered anywhere inside such a frame is `XFER0501`.
3. The next token must be `annot-close`; else `XFER0506` with a message that `!>` is missing (section 12, item 6 asks for a dedicated code), and recover as in step 1.
4. Name handling: `xfer` outside the document head → `XFER0503` at `annot-open`. `id` → value must be a string; record in a document-wide `Set`; repeat → `XFER0505` at `annot-open`. `tag` → value must be a string or symbol. `lang` → value must be a string or symbol. Any other name → `XFER0506`. A wrong value type for a known name is `XFER0506` with a message saying so (section 12, item 6).

Annotations collected before a key inside an object attach to the pair (`PairNode.annotations`); before an item or the root, to the element.

### 7.4 Value model projection (`src/value.ts`)

`toValue(tree: Document): XferValue | undefined` walks the tree iteratively. Any error node, any pair with `value: undefined`, any container with `close: undefined` makes the result `undefined` (the caller already has `ok === false`). Integers: `BigInt` of the lexeme with underscores removed and the sign applied. Duplicate keys: last wins. Annotations: `AnnotationNode` → `{ name, value }` with the value projected.

## 8. JSON (`src/json/`)

**Reader.** A small recursive-descent-by-explicit-stack JSON reader over the text, RFC 8259 strict (no comments, no trailing commas, no single quotes). It keeps number lexemes so `1.50` becomes the fractional `1.50` and `-0` the integer `-0`; a number with a fraction or exponent is `fractional`, otherwise `integer`. Strings are decoded with full escape handling (`\uXXXX` with surrogate pairs). Objects detect duplicate keys and emit `XFER0905` (warning) keeping the last value. Malformed JSON emits `XFER0906` (section 12, item 2) at the fault position and returns `value: undefined`.

**Writer.** Walks an `XferValue` and writes JSON text with its own escaper (`"`, `\`, control characters as `\uXXXX`, `\n` `\r` `\t` `\b` `\f` as the short forms). Integers are written from `value.toString()` (full precision) unless `stringifyBigInts` and the magnitude exceeds 2^53−1, in which case as a string; either way `XFER0901` (warning) when the magnitude exceeds 2^53−1. Fractionals: the lexeme with `_` removed; `inf`, `-inf`, `nan` → `XFER0902` (error) and the writer emits `null` in that position so the output is still JSON. Symbols → string, `XFER0903` (info). Temporals → string, `XFER0904` (info). Annotations dropped. `indent` of 0 or undefined writes compact JSON; otherwise pretty with that many spaces.

## 9. Canonical writer (`src/canonical.ts` and `src/strings.ts`)

Implements spec section 6 exactly. Iterative over the value with an explicit stack of `{ value, indent, phase }`.

```ts
export function chooseDelimiter(content: string, runLimit: number): { form: "rep" | "hash"; run: number };
export function writeString(content: string, runLimit: number): string;
```

`chooseDelimiter`:
1. If `content` contains no `"`: `{ rep, 1 }`.
2. Else if `content` does not start with `"` and does not end with `"`: let `L` be the longest run of `"` in content; `n = L + 1`, and `n = 3` if that gives 2, because a run of two quotes is always the empty string and never opens a string; if `n > runLimit`, `n` = the smallest positive integer other than 2 not equal to the length of any quote run in content (collect run lengths into a `Set`, count up from 1, skipping 2). `{ rep, n }`.
3. Else: let `H` be the longest run of `#` that immediately follows a `"` in content (0 if none); `m = H + 1`; if `m > runLimit`, `m` = the smallest positive integer not equal to any such run length. `{ hash, m }`.

`writeString` renders `"`×n + content + `"`×n, or `#`×m + `"` + content + `"` + `#`×m. Special case: empty content → `""`.

Keys: written bare when the key text satisfies `isIdentifierStart` for its first code point, `isIdentifierContinue` for the rest, does not end with `.`, and is not a keyword; otherwise as `writeString(key)`.

Numbers: integers write the lexeme with any `0x` hex digits lowercased (`lexeme.replace` on the part after the prefix); fractionals write the lexeme as is. Temporals, keywords, symbols as spelled.

Layout: four spaces per level; `{}` and `[]` for empty; otherwise open bracket, newline, each member on its own line, close bracket at the parent indent. Annotations each on their own line before their target at the target's indent, as `<! name value !>` with the value written by the same writer in compact single-line form (an annotation value that is a container is written on one line with single spaces; section 12, item 7). The head, if `version` was present in the source, as `<! xfer 1 !>` on the first line. Output ends with one `\n`.

## 10. CLI (`cli/main.ts`)

Built to `dist/cli.mjs`, `bin: { xfer: "dist/cli.mjs" }`, shebang `#!/usr/bin/env node`. Zero dependencies; argument parsing is a hundred lines by hand.

```
xfer validate [--json] [FILE...]
xfer fmt [--write] [FILE...]            canonical form to stdout, or in place with --write
xfer canon [FILE...]                    alias of fmt without --write
xfer to-json [--pretty] [--stringify-big-ints] [FILE...]
xfer from-json [FILE...]
xfer --version | --help
```

- No `FILE` or `-` reads stdin. Several files are processed in order; output is concatenated for converters and per-file for `validate`.
- Input is read as bytes and passed as `Uint8Array`, so UTF-8 validation and positions are the library's.
- Diagnostics print to stderr in GNU format: `FILE:LINE:COL: error XFER0404: message` (`-` for stdin). With `--json`, one JSON object per diagnostic per line, fields as in `Diagnostic` plus `file`.
- Exit codes: 0 success with no error diagnostics; 1 at least one error diagnostic in any input; 2 usage error or unreadable file (message to stderr).
- `fmt --write` writes only if the canonical text differs from the input bytes, and never writes a file whose parse had errors.

`test/cli.test.ts` spawns `node dist/cli.mjs` on suite documents and asserts output and exit codes; it is the only test that needs the build.

## 11. Testing and the suite

### 11.1 Submodule

`suite/` is the `xferlang` repository as a git submodule, pinned to a commit. `npm run suite:update` fast-forwards it and is a pull request on its own. CI fails if the submodule is not checked out.

### 11.2 txtar reader (`test/txtar.ts`)

```ts
export function readTxtar(text: string): Map<string, string>;  // name -> content, in order
```

A line that matches `/^-- (.+?) --$/` starts an entry; content runs to the next such line or end of file and includes its final newline. Text before the first entry is ignored. Group entries by stem: `<stem>.xfer`, `<stem>.canonical.xfer`, `<stem>.value.json`, `<stem>.diag`.

### 11.3 Tagged values (`test/tagged.ts`)

`toTagged(value: XferValue): unknown` produces the suite's form (`suite/tests/README.md`): every node `{ "type": ..., "value": ... }`; integers in decimal via `value.toString()`; fractionals as the lexeme with `_` removed; objects as `{ "type": "object", "value": { key: tagged } }` in order; sequences as arrays; annotations as `"annotations": [{ name, value: tagged }]` placed before `type` only for key-order stability in failure diffs (comparison is structural, so order does not matter). The document form is `{ "xfer": n, "root": tagged }` with `xfer` present only when the source had a head.

### 11.4 Conformance tests (`test/conformance.test.ts`, `test/bytes.test.ts`)

For every valid stem: `parse(input)`; assert `ok`; assert `canonical(result.value)` (with the head written when `version` came from the source: pass the tree) equals `<stem>.canonical.xfer` byte for byte; assert `toTagged` structurally equals `JSON.parse(<stem>.value.json)`; assert the lossless property (section 3.3) for the tree; assert `canonical(parse(canonical).value)` equals the canonical text (idempotence).

For every invalid stem: `parse(input)`; assert `!ok`; for each line `CODE L:C` in `.diag` assert some diagnostic has that code at that line and column; for `CODE *` assert some diagnostic has that code. Additional diagnostics are permitted.

`bytes/` cases are read as `Uint8Array` from files; the same assertions apply. Stems ending `-at-minimum` run with default limits (which are the minimums) and are required.

Tests are generated with `describe`/`it` per stem so a failure names the case.

### 11.5 Property tests (`test/property.test.ts`, fast-check)

- **Embedding:** `fc.stringOf(fc.constantFrom("a", '"', "#", " ", "\n"), { maxLength: 64 })`, 10,000 runs: `writeString(s)` parsed as a document yields `value.kind === "string"` with `value === s`.
- **Whitespace:** for every valid suite document: collapse each maximal whitespace run outside strings and comments to one space (use the lexer's token stream: rebuild text from tokens with a single space wherever leading trivia contained whitespace, keeping comments) and assert equal tagged values and equal canonical output.
- **Never throws:** `fc.string()` and `fc.uint8Array()`, 10,000 runs each: `parse` returns without throwing.

### 11.6 Coverage

`vitest --coverage` with v8; the floor is 95% lines on `src/`, enforced in CI.

## 12. Items this design pins that the specification must state

Each of these is a spec change to make in the `xferlang` repository in the same change as the first implementation commit that depends on it.

1. **Positions are in the normalized text.** Spec 9 says "UTF-8 byte offset" without saying of what. After CR normalization, offsets differ from the input's; the suite's cases are LF so no case is affected, but the rule must be written. (Done: spec section 9, commit 55cdffc.)
2. **A code for malformed JSON in `fromJson`:** `XFER0906`, error, "malformed JSON". The spec's table stops at 0905.
3. **Leap seconds:** second 60 is accepted, as RFC 3339 permits. Spec 4.6 says "denotes no instant" without listing ranges; list them. (Done: spec 4.6, commit 55cdffc.)
4. **The head and whitespace:** "first token of the document" should say that leading whitespace is permitted before the head and comments are not.
5. **Duplicate keys in the value model:** last wins in the tree-to-value projection (the parse is already an error; this only governs tools reading the tree).
6. **Codes for a malformed annotation and a wrong-typed annotation value.** This design uses `XFER0506` with a distinguishing message; the spec should either confirm that or add `XFER0507` (malformed annotation) and `XFER0508` (annotation value of the wrong type).
7. **Canonical form of a container-valued annotation:** one line, single spaces, as `<! name { a 1 } !>`. Spec 6 rule 6 says "in canonical form" without saying that annotations do not break lines.
8. **`XFER0602` recovery:** after the depth diagnostic, the bracket is an error node and its contents are parsed at the same depth. The spec says only that exceeding a limit is a diagnostic.

## 13. Build, packaging, CI, release

- **`package.json`:** `"name": "xferlang"`, `"type": "module"`, `"version"` managed by changesets, `"license": "MIT"`, `"engines": { "node": ">=18" }`, `"sideEffects": false`, `"files": ["dist", "README.md", "LICENSE"]`, `"bin": { "xfer": "dist/cli.mjs" }`, `"exports": { ".": { "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }, "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" } }, "./package.json": "./package.json" }`, `"main"`, `"module"`, `"types"` set to the same files for older tooling, `"repository"`, `"homepage": "https://xfer.parkscomputing.com"`, `"keywords"`.
- **TypeScript:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `target: ES2022`, `lib: ["ES2022"]` (no DOM; `TextDecoder` comes from `lib.dom` or `@types/node`; declare the two globals locally in `src/globals.d.ts` to avoid either). Two configs: `tsconfig.json` compiles `src` with `types: []` so that using `process`, `Buffer` or any Node module in the core is a compile error (verified 2026-10-18), and `tsconfig.node.json` extends it with Node types for `cli`, `test` and the root config files. `npm run typecheck` runs both.
- **Build:** `tsdown` producing `dist/index.js` (ESM, since the package is `"type": "module"`), `dist/index.cjs`, `dist/index.d.ts`, `dist/index.d.cts`, and `dist/cli.mjs` (ESM only, with the shebang banner and the executable bit). The core size is measured by `size-limit` as minified bytes with no compression (the stricter reading of the budget); budget 20 kB.
- **Lint and format:** `biome` with the recommended rules plus `noExplicitAny: error`; `npm run check` runs biome, `tsc --noEmit`, and the tests.
- **CI (`ci.yml`):** on push and pull request; matrix Node 22, 24 × ubuntu, windows, macos: install with `npm ci`, `npm run check`, `npm run build`, `npm run test:cli`, `size-limit`. Node 22 is the floor because the build and test tools require it (tsdown needs 22.18 or later, Vitest 22.12 or later), so the full check cannot run on older Node. Runtime compatibility on older Node is a separate job added in step 9: it builds on Node 24, then runs the built `dist` on Node 18 and 20 with a plain `node:test` runner that executes the conformance cases without Vitest. Also a `deno` job (`deno test` importing `dist/index.js` and running the conformance cases through a small Deno-side runner) and a `bun` job (`bun test` the same). Submodule checked out with `submodules: true`.
- **Release (`release.yml`):** on push to `main`, changesets opens or updates the version pull request; merging it runs `npm publish --provenance --access public` under an OIDC trusted publisher (no long-lived token), tags `v<version>`, and attaches `CHANGELOG.md` section to the GitHub release. Prereleases use changesets' `pre` mode with tag `next`.
- **Docs:** README with the thirty-second example, the JSON mapping on the first screen, the API on one page, and links to the spec and the site; `typedoc` to `docs/` published by Pages.
- **Security:** `SECURITY.md` with the disclosure address; `npm audit` in CI for dev dependencies only (there are no runtime ones).

## 14. Order of implementation and definition of done

Each step is done when its tests pass in CI on every matrix cell.

1. **Scaffold.** Repository, submodule, configs, empty `src/index.ts`, CI green on nothing.
2. **Harness.** `txtar.ts`, `tagged.ts`, generated conformance and bytes tests, all failing with "not implemented". This is the first real deliverable: the suite is executable.
3. **`normalize.ts`, `unicode.ts`, `diagnostics.ts`, `limits.ts`.** Unit tests for BOM, CR, CRLF, invalid UTF-8, lone surrogates, the excluded ranges, UTF-8 lengths.
4. **`lexer.ts`.** All `1xx`, `2xx`, `3xx`, `4xx` invalid cases produce their diagnostics at their positions; all valid cases lex without diagnostics. Expect to find spec and suite faults here; fix them in `xferlang` and bump the submodule.
5. **`parser.ts`, `value.ts`.** All `5xx` and `7xx` cases; the lossless property; `parse` and `parseValue` public.
6. **`canonical.ts`, `strings.ts`.** Every `.canonical.xfer` matches; idempotence; the embedding property test.
7. **`json/`, `plain.ts`.** Unit tests from the spec's mapping tables; a round trip of every valid suite document through `toJson`/`fromJson` compared on the plain projection.
8. **CLI.** `cli.test.ts`; the `xfer` binary works from `npx` on a fresh checkout.
9. **Deno and Bun jobs,** size budget, coverage floor, typedoc, README.
10. **Publish `0.1.0`** with the `next` tag. Open the issue in `xferlang` listing every spec change made during steps 3 to 8, so that `xfer-dotnet` starts from the corrected spec.

## 15. When the spec and this implementation disagree

1. Do not special-case the suite file. Do not "fix" the case to match the code.
2. Decide which is wrong by reading the spec rule the case cites. If the spec is ambiguous, write down both readings.
3. If the spec or suite is wrong: open a commit in `xferlang` that changes the rule and its cases together, with the reasoning in the message; bump the submodule here; cite the commit in this repository's change.
4. If the design in this document is wrong: fix the code, and record the change in section 16.
5. If it needs a ruling (two defensible readings): stop, write the question with both readings and a recommendation into `xferlang/history/REBOOT_PROPOSAL.md` section 7 as a pending item, and continue with other work until it is ruled on.

## 16. Decisions recorded

Step 1 (scaffold) was completed on 2026-10-18. The decisions it required, and the places it departs from sections 1 to 15 above:

- **Dev toolchain floor is Node 22.** Current tsdown requires Node `^22.18 || >=24.11` and current Vitest requires `^22.12 || ^24 || >=26`, so the CI matrix in section 13 (Node 18 to 24 running the full check) is not possible. Section 13 now says Node 22 and 24, with an older-runtime job to be added in step 9. The local machine's Node 24.4.1 is below the newest tools' floor (24.11), which npm warns about; the build and checks still ran, but updating Node locally is advised.
- **Runtime floor is pending Paul.** `engines` is `>=18` as the design says, but nothing verifies it until the step 9 job exists, and Node 18 and Node 20 are both past end of life. Recommendation: keep `>=18` only if the step 9 job passes on 18, otherwise set `>=20`; or decide now to set `>=22` and drop the older-runtime job. The core uses only `TextDecoder`, `TextEncoder`, `Map` and `BigInt`, so 18 should work.
- **Output file names** follow tsdown's convention for a `"type": "module"` package: `index.js` (ESM), `index.cjs`, `index.d.ts`, `index.d.cts`, and `cli.mjs`. The design had `.mjs` for the ESM core. Sections 13 and the exports map are updated.
- **Default branch is `master`**, matching the other repositories, not `main` as sections 13 and 14 assume. `.changeset/config.json` has `baseBranch: "master"` and the workflow triggers on both names. If the GitHub repository is created with `main`, change `baseBranch` and the workflow.
- **`@changesets` config was written by hand,** because `changeset init` is interactive. Schema reference is `@changesets/config@4.0.1`; the changelog generator is the built-in one (no GitHub integration).
- **Biome 2.5 syntax.** The `recommended` rule field is deprecated; the config uses `"preset": "recommended"`, produced by `biome migrate`.
- **Pinned dev dependencies** (exact versions in `package.json` and the lockfile): TypeScript 6.0.3, Vitest 5.0.5 and its v8 coverage provider, Biome 2.5.15, tsdown 0.22.2, size-limit 14.2.0 with the small-lib preset, @changesets/cli 3.0.3, @types/node 22.20.5. `fast-check` is added in step 6 and `typedoc` in step 9.
- **`package.json` is `private: true`** until the first release (step 10), so an accidental publish is impossible. Remove it in that step.
- **GitHub repositories created 2026-10-18,** both public: `paulmooreparks/xferlang` and `paulmooreparks/xfer-js`, default branch `master`. `.gitmodules` records the GitHub URL of the spec repository and the local clone was synced to it. The spec repository is public, so CI checks out the submodule with no token. The first CI run passed on all six matrix legs (Ubuntu, Windows and macOS, Node 22 and 24).
- **GitHub Actions versions.** The workflow used `actions/checkout@v4` and `actions/setup-node@v4`, which GitHub reported as the deprecated Node 20 runtime. Both are now `@v7`, the latest majors on 2026-10-18. Watch for the `ubuntu-latest` label migrating to Ubuntu 26 on 2026-10-19; nothing in the workflow depends on the image version.
- **`release.yml` is deferred** to step 9 or 10, because it cannot be tested before there is something to publish, and it needs npm trusted publishing configured on the registry side.
- **Contact in `SECURITY.md`** is paul@parkscomputing.com, taken from the legacy project's README.
- **The `xferlang` spec repository gained its `LICENSE` file** (the README already claimed MIT).

Step 2 (harness) was completed on 2026-10-18. What it decided and found:

- **Expected-failures list.** Section 14 says the conformance tests all fail until implemented, but `master` must keep CI green. `test/expected-failures.txt` lists the id of every case the implementation is not yet expected to pass, and the runner registers a listed case with Vitest's `it.fails`: it must fail, and when it starts passing its test fails ("Expect test to fail") and the line is deleted. A case that is not listed must pass. This was verified three ways: removing a case from the list turns it red with the real cause (`not implemented`); an id that names no case fails the stale-list check; and an expected failure that passes turns red. The rule, stated in the file's header, is that a case is never added to the list to hide a regression, only because it is new to the suite and the implementation has not reached it. Each later step deletes the lines for the cases it makes pass. The list started with all 106 cases.
- **Bytes cases run in `conformance.test.ts`,** in the same generated suite as the archives, instead of a separate `bytes.test.ts`. A case's id is `valid/<stem>`, `invalid/<stem>` or `bytes/<stem>`.
- **Member order is checked separately.** Structural equality ignores key order, but the specification makes object member order normative, so the runner also compares `memberOrder()` of the actual and expected tagged values. JavaScript hoists integer-like keys, so for those only the canonical text can check order.
- **The suite loader validates the suite** (`test/cases.ts`): a malformed `.diag` line, a case with both `.diag` and valid-case files, a missing entry, a duplicate id or a duplicate txtar entry name throws with a message naming the case. It found a real defect on first use (next item).
- **Suite defect found and fixed upstream.** `bytes/320-crlf-normalized.value.json` and `bytes/320-lone-cr-normalized.value.json` held a raw newline inside a JSON string, which is not valid JSON. Nothing had parsed them before. Fixed in `xferlang` (commit cb5c2d0, pushed) and the submodule bumped to it, following section 15.
- **`src/types.ts` was written in full** from section 3, because the harness helpers need it. `parse`, `parseValue` and `canonical` exist as stubs that throw `not implemented`, so the harness imports the real public API; `src/index.ts` exports them and all the types. `DiagnosticCode` is a template-literal type until step 3 narrows it to the specification's table.
- **`test/lossless.ts` and `test/tagged.ts` are iterative,** as section 1 requires of the tagged-value helper; a unit test nests a hundred thousand levels.
- **`npm run suite:cases` lists every case id** by running a TypeScript file directly under Node's type stripping, which is on by default in Node 22.18 and later and prints an experimental warning to stderr on 24.4.

Step 3 (normalize, unicode, diagnostics, limits) was completed on 2026-10-18. No conformance case can pass before the lexer, so the expected-failures list is unchanged at 106. What it decided:

- **Two checks tie the code to the specification text.** `test/unicode.test.ts` reads the exclusion sentence in specification 4.3, expands it to its 38 code points, and compares `isAdmittedNonAscii` with it for every code point from U+0080 to U+10FFFF. `test/diagnostics.test.ts` parses the diagnostic table in specification section 10 and compares `DIAGNOSTICS` with it row for row, and checks that every code the suite requires is in the table. Each was verified to fail when the code is deliberately wrong (an exclusion range shortened by one, a summary reworded). A spec change to either now fails this repository's build until the code follows.
- **`DiagnosticCode` is the union of the table's keys,** `keyof typeof DIAGNOSTICS`, and `types.ts` re-exports it. A diagnostic cannot be built with a code the specification does not define.
- **Additions to the design's module list.** `src/position.ts` holds `ORIGIN` and `positionAt(text, index)`, which `normalize` needs to report a lone surrogate at its real line and column; the lexer tracks its position incrementally and will not use it for ordinary tokens. `src/unicode.ts` gained `isWhitespace` (specification 3.3, which the lexer needs) and `utf8ByteLength`.
- **Position rules in `normalize`.** Invalid UTF-8 in byte input is reported at offset 0, line 1, column 1, because the platform decoder does not say where it failed. A lone surrogate in string input is reported at its own position, with the offset in UTF-8 bytes and the column in scalar values, measured in the normalized text (after the byte order mark and CR are handled), which is how section 12 item 1 says positions are measured. The design had said "scalar-value offset", which would not have been a `Position`.
- **The size limit is measured on the input as supplied,** before the byte order mark is removed and line endings change, and before decoding, so oversized invalid input reports `XFER0601`.
- **Limits.** `resolveLimits` treats a value that is below the minimum or not a number (including `NaN`, a string or `null`) as unset, and returns a frozen object. An infinite value is accepted, as "no limit".
- **Still to add to the specification,** per section 12: `XFER0906` for malformed JSON, and the two annotation codes if the spec wants them. Neither is needed until steps 5 and 7.

**Cold review of step 3 (2026-10-18, a separate Opus agent with no prior context).** Two bugs and two specification problems, all addressed in step 4's commit:

- `normalize` caught every exception as invalid UTF-8, so a valid 512 MiB document (which the engine cannot hold as one string) was reported as `XFER0701`. It now reports `XFER0701` only for the `TypeError` the Encoding standard defines, and reports any other decoding failure as `XFER0601` with "larger than this platform can decode", without throwing. Both paths are tested with a stub decoder. Treating "anything that is not a TypeError" as a size problem is a safety net for a failure the platform does not specify, not a branch the design depends on.
- `isAdmittedNonAscii` was written as rejections, so `NaN`, a fraction or `undefined` passed as an identifier character. It is now an acceptance (`Number.isInteger` and in range), with tests for those values.
- `positionAt` now stops at the end of the text and never returns a position after a surrogate pair for an index inside it.
- The diagnostics-table test now also checks that every line of the spec's table parsed, so a badly formatted new row cannot be skipped on both sides.
- **Ruled by Paul, 2026-10-18:** spec 3.4's minimum of 2^31−1 bytes for document size and token length could not be met by any JavaScript engine (V8 holds about 2^29 UTF-16 units) or by .NET. Both minimums are now 2^28−1 bytes in the specification and in `LIMIT_MINIMUMS`.
- The API's severity `"info"` is the spec's "informational". This is a deliberate name, matching common tooling.

Step 4 (lexer) was completed on 2026-10-18, on Opus. Every valid suite document lexes with no diagnostic and is reproduced exactly by its tokens; all 50 invalid cases whose required diagnostics are lexical produce them at the stated positions (so the hand-computed positions in those cases are now verified); and 3,000 seeded random inputs lex without throwing, reproduce exactly, and report every token and trivia position equal to an independent count. The expected-failures list grew to 123 because the suite grew; no case leaves it until the parser exists in step 5, because the conformance runner needs a value and a canonical form.

- **Faults found in the specification and suite, fixed upstream** (xferlang commit 55cdffc, following section 15): spec 4.5 listed `.5` and `+1` as `XFER0302` while section 4 and the suite say `XFER0103`; the temporal ranges were missing from 4.6; the rules for `-inf`, signed temporals, uppercase radix prefixes and lowercase `z` were unstated; section 9 did not say positions are in the normalized text; `530-object-minimal-whitespace` contained `c"x"`, which the separation ruling forbids; four invalid cases were named for the wrong code. Seventeen cases were added.
- **Faults found in this design, corrected in section 5:** the `-inf` rule required a terminator after `inf`, which contradicted the suite (`-infinity` is `XFER0101` at the second `i`); the leading-zero check came before the temporal check, which would have rejected the year `0001` and the hour `09`; a sign did not prevent a temporal, so `-2025-08-01` would have lexed as a date; an uppercase radix prefix was not handled, which would have reported `0XFF` as `0` plus a separation error instead of `XFER0302`; and a delimiter run over the limit treated the rest of the document as one string, where reading on to the exact closer recovers better.
- **Hints.** A character people bring from other formats (comma, colon, apostrophe, parenthesis, `+`, a leading point, `~`, `?`) gets a hint in its diagnostic. The hint appears whether the character fails the separation rule (`[ 1, 2 ]`) or cannot begin a token (`( 1 )`).
- **Ruled by Paul, 2026-10-18: a run of exactly two quotes is always the empty string.** The specification's rule ("exactly two quotes followed by anything other than a quote") contradicted its own `""...""` examples: by that rule `""He said "hello" and left.""` is the empty string followed by `He`. Of the three fixes offered, Paul chose this one: a string whose content contains a quote opens with one quote or with three or more, so `""` is never ambiguous and a slip fails loudly. The specification, grammar, canonical rule, README and the suite's `""...""` cases were updated (xferlang, the commit after 55cdffc), and section 9's choice rule now skips 2. The rejected alternative, `""` empty only before a terminator, would have parsed a slip silently as different values and needed another canonical special case.
- **Ruled by Paul, 2026-10-18: the size minimums are 2^28−1 bytes.** See the review entry above.
