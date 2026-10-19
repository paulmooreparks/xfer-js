import { XferError } from "./error";
import { KEYWORDS } from "./keywords";
import { tokenize } from "./lexer";
import { resolveLimits } from "./limits";
import { writeString } from "./strings";
import type { Annotation, CanonicalOptions, Diagnostic, ParseResult, XferValue } from "./types";
import { isIdentifierContinue, isIdentifierStart } from "./unicode";
import { parseInteger } from "./value";

const INDENT = "    ";

/** The annotation names a document can carry on a value. `xfer` is the head, not an annotation. */
const ANNOTATION_NAMES: ReadonlySet<string> = new Set(["id", "tag", "lang"]);

// A carriage return, or half of a surrogate pair.
const UNWRITABLE = /\r|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether text can be written bare, as a key or as a symbol (specification 4.3). */
function isBareName(text: string): boolean {
  let first = true;
  let last = 0;
  for (const character of text) {
    const cp = character.codePointAt(0) as number;
    if (first ? !isIdentifierStart(cp) : !isIdentifierContinue(cp)) {
      return false;
    }
    first = false;
    last = cp;
  }
  return !first && last !== 0x2e && !KEYWORDS.has(text);
}

/**
 * Refuses text that no document can hold. A document is normalized before it is read, so U+000D
 * becomes LF and cannot be part of a value (specification 3.2), and a lone surrogate is not a
 * scalar value. Writing either would give a document that reads back as a different value.
 */
function assertWritable(text: string): void {
  const bad = UNWRITABLE.exec(text);
  if (bad !== null) {
    const unit = (bad[0] as string).charCodeAt(0);
    throw new TypeError(
      `a string cannot contain U+${unit.toString(16).toUpperCase().padStart(4, "0")}: ` +
        "a document cannot hold it, so it would be read back as a different value",
    );
  }
}

/** A hexadecimal integer is written with lower-case digits; everything else is as it was written. */
function integerText(lexeme: string): string {
  const hex = /^(-?0x)(.*)$/.exec(lexeme);
  return hex === null ? lexeme : `${hex[1]}${(hex[2] as string).toLowerCase()}`;
}

/** Whether the lexeme is exactly one token of the kind, as the lexer would read it. */
function isLexeme(kind: string, lexeme: unknown): lexeme is string {
  if (typeof lexeme !== "string" || lexeme === "") {
    return false;
  }
  const diagnostics: Diagnostic[] = [];
  const tokens = tokenize(lexeme, resolveLimits(), diagnostics);
  const token = tokens[0];
  if (diagnostics.length > 0 || tokens.length !== 2 || token === undefined) {
    return false;
  }
  if (token.text !== lexeme) {
    return false;
  }
  if (kind === "fractional") {
    return (
      token.kind === "fractional" ||
      (token.kind === "keyword" &&
        token.keyword !== "true" &&
        token.keyword !== "false" &&
        token.keyword !== "null")
    );
  }
  return token.kind === kind;
}

interface Context {
  readonly runLimit: number;
  readonly depthLimit: number;
  readonly maxChars: number;
  /** A value from a successful parse is known to be well formed; one built by hand is checked. */
  readonly trusted: boolean;
  readonly ids: Set<string>;
  size: number;
}

/** The text of a scalar, checking a hand-built one: the output must always read back as the value. */
function scalarText(
  value: Exclude<XferValue, { kind: "object" | "sequence" }>,
  ctx: Context,
): string {
  switch (value.kind) {
    case "string":
      if (!ctx.trusted) {
        assertWritable(value.value);
      }
      return writeString(value.value, ctx.runLimit);
    case "integer":
      if (!ctx.trusted) {
        if (!isLexeme("integer", value.lexeme) || parseInteger(value.lexeme) !== value.value) {
          throw new TypeError(
            `${JSON.stringify(value.lexeme)} is not the lexeme of the integer ${String(value.value)}`,
          );
        }
      }
      return integerText(value.lexeme);
    case "fractional":
      if (!ctx.trusted && !isLexeme("fractional", value.lexeme)) {
        throw new TypeError(`${JSON.stringify(value.lexeme)} is not a fractional number`);
      }
      return value.lexeme;
    case "bool":
      return value.value ? "true" : "false";
    case "null":
      return "null";
    case "symbol":
      if (!isBareName(value.name)) {
        throw new TypeError(`${JSON.stringify(value.name)} is not a valid symbol name`);
      }
      return value.name;
    case "date":
    case "time":
    case "local-datetime":
    case "datetime":
      if (!ctx.trusted && !isLexeme(value.kind, value.lexeme)) {
        throw new TypeError(`${JSON.stringify(value.lexeme)} is not a ${value.kind}`);
      }
      return value.lexeme;
    default:
      throw new TypeError(
        `${JSON.stringify((value as { kind: unknown }).kind)} is not a kind of value`,
      );
  }
}

/** Checks a hand-built annotation: only what a document can carry, once per id, with a scalar value. */
function checkAnnotation(annotation: Annotation, ctx: Context): void {
  const { name, value } = annotation;
  if (!ANNOTATION_NAMES.has(name)) {
    throw new TypeError(
      `${JSON.stringify(name)} is not an annotation a value can carry (id, tag and lang are; xfer is the head)`,
    );
  }
  if (value === undefined || (value.annotations !== undefined && value.annotations.length > 0)) {
    throw new TypeError(`the value of the ${name} annotation cannot carry an annotation`);
  }
  const fits =
    name === "id" ? value.kind === "string" : value.kind === "string" || value.kind === "symbol";
  if (!fits) {
    throw new TypeError(
      `the ${name} annotation takes ${name === "id" ? "a string" : "a string or a symbol"}`,
    );
  }
  if (name === "id") {
    const id = (value as { value: string }).value;
    if (ctx.ids.has(id)) {
      throw new TypeError(`the id ${JSON.stringify(id)} is used twice`);
    }
    ctx.ids.add(id);
  }
}

interface Frame {
  readonly values: readonly XferValue[];
  readonly keys: readonly string[] | undefined;
  readonly indent: number;
  readonly closer: "}" | "]";
  next: number;
}

/**
 * Writes the value in the canonical layout: every member on its own line, four spaces in per
 * level. Iterative, so depth cannot overflow the stack. The result has no final newline.
 */
function writeValue(root: XferValue, ctx: Context): string {
  const out: string[] = [];
  const stack: Frame[] = [];
  const put = (...parts: string[]) => {
    for (const part of parts) {
      ctx.size += part.length;
      out.push(part);
    }
    if (ctx.size > ctx.maxChars) {
      throw new XferError([], `the canonical form is longer than ${ctx.maxChars} characters`);
    }
  };

  // An annotation goes before the element or pair it attaches to, on its own line. In the value
  // model a pair's annotations are on its value, so they come out before the key.
  const annotations = (target: XferValue, level: number) => {
    for (const a of target.annotations ?? []) {
      if (!ctx.trusted) {
        checkAnnotation(a, ctx);
      }
      const value = a.value as Exclude<XferValue, { kind: "object" | "sequence" }>;
      put(INDENT.repeat(level), "<! ", a.name, " ", scalarText(value, ctx), " !>\n");
    }
  };

  const finishItem = () => {
    if (stack.length > 0) {
      put("\n");
    }
  };

  const emit = (value: XferValue, level: number) => {
    if (value.kind !== "object" && value.kind !== "sequence") {
      put(scalarText(value, ctx));
      finishItem();
      return;
    }
    const isObject = value.kind === "object";
    const members = isObject ? [...value.entries.values()] : value.items;
    // The output grows with the square of the depth, so the depth limit also bounds the output.
    // An empty collection counts too: it is a level that a parser at the limit would refuse.
    if (stack.length >= ctx.depthLimit) {
      throw new XferError([], `the value is nested more than ${ctx.depthLimit} levels deep`);
    }
    if (members.length === 0) {
      put(isObject ? "{}" : "[]");
      finishItem();
      return;
    }
    put(isObject ? "{" : "[", "\n");
    stack.push({
      values: members,
      keys: isObject ? [...value.entries.keys()] : undefined,
      indent: level,
      closer: isObject ? "}" : "]",
      next: 0,
    });
  };

  annotations(root, 0);
  emit(root, 0);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.next < frame.values.length) {
      const i = frame.next++;
      const item = frame.values[i] as XferValue;
      const level = frame.indent + 1;
      annotations(item, level);
      put(INDENT.repeat(level));
      if (frame.keys !== undefined) {
        const key = frame.keys[i] as string;
        if (!ctx.trusted) {
          assertWritable(key);
        }
        put(isBareName(key) ? key : writeString(key, ctx.runLimit), " ");
      }
      emit(item, level);
    } else {
      stack.pop();
      put(INDENT.repeat(frame.indent), frame.closer);
      finishItem();
    }
  }
  return out.join("");
}

/**
 * The canonical form of a document (specification 6): one spelling for a value, so two
 * implementations given the same document produce the same bytes. Comments are not part of it.
 *
 * Takes a `ParseResult`, which also keeps the `xfer` head and is trusted to be well formed: a
 * result with an error is refused with an `XferError` carrying its diagnostics. Or takes a value,
 * which has no head; a value built by hand is checked, and a `TypeError` is thrown for anything
 * no document could hold (a string with U+000D, an annotation a value cannot carry, a number
 * whose lexeme is not that number), so that the output always reads back as the value.
 *
 * Throws an `XferError` if the value is nested deeper than the depth limit, or the output would
 * be longer than the document-size limit. Both limits default to the specification's minimums, so
 * a result parsed with raised limits needs the same limits passed here.
 */
export function canonical(input: XferValue | ParseResult, options?: CanonicalOptions): string {
  const limits = resolveLimits(options?.limits);
  let value: XferValue;
  let head = false;
  let trusted = false;
  if (typeof input === "object" && input !== null && "kind" in input) {
    value = input;
  } else if (typeof input === "object" && input !== null && "ok" in input && "tree" in input) {
    if (!input.ok) {
      throw new XferError(input.diagnostics);
    }
    if (input.value === undefined) {
      throw new XferError(input.diagnostics, "the parse produced no value");
    }
    value = input.value;
    head = input.tree.head !== undefined;
    trusted = true;
  } else {
    throw new TypeError("canonical takes a value or the result of a parse");
  }
  const ctx: Context = {
    runLimit: limits.runLength,
    depthLimit: limits.depth,
    maxChars: limits.documentBytes,
    trusted,
    ids: new Set(),
    // The head and the final line feed count towards the document size too.
    size: (head ? "<! xfer 1 !>\n".length : 0) + 1,
  };
  return `${head ? "<! xfer 1 !>\n" : ""}${writeValue(value, ctx)}\n`;
}
