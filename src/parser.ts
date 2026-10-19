import type { DiagnosticCode } from "./diagnostics";
import { makeDiagnostic } from "./diagnostics";
import { Lexer } from "./lexer";
import type {
  AnnotationNode,
  Diagnostic,
  Document,
  Limits,
  Node,
  PairNode,
  Token,
  TokenKind,
} from "./types";

const NONE: readonly AnnotationNode[] = Object.freeze([]);
const NO_TOKENS: readonly Token[] = Object.freeze([]);

const SCALAR_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "string",
  "integer",
  "fractional",
  "date",
  "time",
  "local-datetime",
  "datetime",
  "keyword",
  "identifier",
]);

// Frames: the document, each open container, and each open annotation.

interface DocFrame {
  readonly kind: "doc";
  pending: AnnotationNode[];
}

interface SequenceFrame {
  readonly kind: "sequence";
  readonly open: Token;
  readonly annotations: readonly AnnotationNode[];
  readonly items: Node[];
  pending: AnnotationNode[];
}

interface ObjectFrame {
  readonly kind: "object";
  readonly open: Token;
  readonly annotations: readonly AnnotationNode[];
  readonly pairs: PairNode[];
  readonly keys: Set<string>;
  pending: AnnotationNode[];
  // Between a key and its value: the key (absent when a bracket stood where a key belongs), the
  // annotations that came before it, and any stray separators skipped since.
  expectingValue: boolean;
  key: Token | undefined;
  pairAnnotations: readonly AnnotationNode[];
  skipped: (Token | AnnotationNode)[];
}

interface AnnotationFrame {
  readonly kind: "annotation";
  readonly open: Token;
  name: Token | undefined;
  value: Node | undefined;
  close: Token | undefined;
  phase: "name" | "value" | "close";
  pending: AnnotationNode[];
  // The very first token of the document, with no comment before it: the only place the `xfer`
  // head may stand.
  readonly candidateHead: boolean;
  // How many objects and sequences were open outside this annotation, saved so that a closing
  // bracket inside the annotation's value is never matched with one outside it.
  readonly outerObjects: number;
  readonly outerSequences: number;
}

/**
 * A container deeper than the depth limit. It is not parsed: its tokens are kept in one error node
 * and only its brackets are counted, so the contents add no diagnostics beyond the one for the
 * limit and the tree stays lossless.
 */
interface OverflowFrame {
  readonly kind: "overflow";
  readonly annotations: readonly AnnotationNode[];
  readonly tokens: Token[];
  level: number;
}

type Frame = DocFrame | SequenceFrame | ObjectFrame | AnnotationFrame | OverflowFrame;

/** Hands over the annotations waiting for a target, leaving none behind. */
function take(frame: Exclude<Frame, OverflowFrame>): readonly AnnotationNode[] {
  if (frame.pending.length === 0) {
    return NONE;
  }
  const taken = frame.pending;
  frame.pending = [];
  return taken;
}

function errorNode(tokens: readonly Token[], annotations: readonly AnnotationNode[]): Node {
  return { kind: "error", tokens, annotations };
}

/** An annotation with a name, a value that is a value and a closing `!>`: one with a meaning to check. */
function isComplete(a: AnnotationNode): boolean {
  return (
    a.name?.kind === "identifier" &&
    a.value !== undefined &&
    a.value.kind !== "error" &&
    a.close !== undefined
  );
}

/**
 * A `,` or `:` carried over from JSON or YAML. The lexer has reported it, with a hint. The parser
 * skips it instead of reading it as a key or a value, because reading it as one shifts every
 * key and value after it, and one stray colon would otherwise cost an error per pair.
 */
function isStraySeparator(token: Token): boolean {
  return token.kind === "error" && (token.text === "," || token.text === ":");
}

// The annotation names the specification defines.
const KNOWN_ANNOTATIONS: ReadonlySet<string> = new Set(["xfer", "id", "tag", "lang"]);

function keyText(token: Token): string {
  return token.kind === "string" ? (token.content ?? "") : token.text;
}

/** At most 21 UTF-16 units and "...", never cutting a surrogate pair in two. */
function shorten(text: string): string {
  if (text.length <= 24) {
    return text;
  }
  const last = text.charCodeAt(20);
  const cut = last >= 0xd800 && last <= 0xdbff ? 20 : 21;
  return `${text.slice(0, cut)}...`;
}

function describe(node: Node | undefined): string {
  if (node === undefined || node.kind === "error") {
    return "?";
  }
  if (node.kind === "object" || node.kind === "sequence") {
    return node.kind;
  }
  const kind = node.token.kind === "identifier" ? "symbol" : node.token.kind;
  return `${kind} ${shorten(node.token.text)}`;
}

/**
 * Turns normalized text into the lossless tree (specification 5 and 7), reporting every fault as
 * a diagnostic and recovering so that one document yields each fault the parser can separate.
 *
 * An explicit stack of frames replaces recursion, so nesting depth is bounded by the depth limit
 * and by memory, never by the call stack. DESIGN.md section 7 is the reference.
 */
export function parseDocument(
  text: string,
  limits: Limits,
  diagnostics: Diagnostic[],
): { tree: Document; version: number } {
  return new Parser(text, limits, diagnostics).run();
}

class Parser {
  private readonly text: string;
  private readonly limits: Limits;
  private readonly diagnostics: Diagnostic[];
  private readonly lexer: Lexer;
  private readonly stack: Frame[] = [{ kind: "doc", pending: [] }];

  private tokenCount = 0;
  private root: Node | undefined;
  private rootDone = false;
  private head: AnnotationNode | undefined;
  private version = 1;
  private readonly trailing: Token[] = [];
  private trailingReported = false;
  private depth = 0;
  private depthReported = false;
  private annotationDepth = 0;
  // Objects and sequences open since the nearest enclosing annotation (or the start), so that a
  // wrong closing bracket can be matched against an outer collection in constant time.
  private openObjects = 0;
  private openSequences = 0;
  private elements = 0;
  private elementsReported = false;
  private readonly ids = new Set<string>();
  private eof: Token | undefined;
  private done = false;

  constructor(text: string, limits: Limits, diagnostics: Diagnostic[]) {
    this.text = text;
    this.limits = limits;
    this.diagnostics = diagnostics;
    this.lexer = new Lexer(text, limits, diagnostics);
  }

  run(): { tree: Document; version: number } {
    let token = this.next();
    while (!this.done) {
      // A step consumes the token, or closes a frame and looks at the same token again. Every
      // step that does not consume pops a frame or ends the document, so this terminates.
      if (this.dispatch(token) && !this.done) {
        token = this.next();
      }
    }
    const eof = this.eof as Token;
    const tree: Document = {
      head: this.head,
      root: this.root,
      trailing: this.trailing,
      eof,
      text: this.text,
    };
    return { tree, version: this.version };
  }

  // Reading and reporting.

  private next(): Token {
    this.tokenCount++;
    return this.lexer.next();
  }

  private top(): Frame {
    return this.stack[this.stack.length - 1] as Frame;
  }

  private report(code: DiagnosticCode, at: Token, detail?: string): void {
    this.diagnostics.push(makeDiagnostic(code, at.start, at.end, detail));
  }

  private count(at: Token): void {
    this.elements++;
    if (this.elements > this.limits.elements && !this.elementsReported) {
      this.elementsReported = true;
      this.report("XFER0605", at);
    }
  }

  private dispatch(token: Token): boolean {
    const frame = this.top();
    switch (frame.kind) {
      case "doc":
        return this.onDocument(frame, token);
      case "sequence":
        return this.onSequence(frame, token);
      case "object":
        return frame.expectingValue
          ? this.onObjectValue(frame, token)
          : this.onObject(frame, token);
      case "annotation":
        return this.onAnnotation(frame, token);
      case "overflow":
        return this.onOverflow(frame, token);
    }
  }

  // Values.

  /** Handles a token that can begin a value. Never refuses a token other than `eof`. */
  private startValue(token: Token, annotations: readonly AnnotationNode[]): boolean {
    switch (token.kind) {
      case "lbrace":
      case "lbrack":
        this.openContainer(token, annotations);
        return true;
      case "annot-close":
        this.report("XFER0103", token, "`!>` closes an annotation, and none is open");
        this.count(token);
        this.deliver(errorNode([token], annotations));
        return true;
      case "eof":
        return false;
      default:
        // Scalars, and the error tokens the lexer already reported.
        this.count(token);
        this.deliver(
          SCALAR_KINDS.has(token.kind)
            ? { kind: "scalar", token, annotations }
            : errorNode([token], annotations),
        );
        return true;
    }
  }

  private openContainer(token: Token, annotations: readonly AnnotationNode[]): void {
    this.count(token);
    if (this.depth >= this.limits.depth) {
      if (!this.depthReported) {
        this.depthReported = true;
        this.report("XFER0602", token, `more than ${this.limits.depth} levels`);
      }
      this.stack.push({ kind: "overflow", annotations, tokens: [token], level: 1 });
      return;
    }
    this.depth++;
    if (token.kind === "lbrack") {
      this.openSequences++;
      this.stack.push({ kind: "sequence", open: token, annotations, items: [], pending: [] });
    } else {
      this.openObjects++;
      this.stack.push({
        kind: "object",
        open: token,
        annotations,
        pairs: [],
        keys: new Set(),
        pending: [],
        expectingValue: false,
        key: undefined,
        pairAnnotations: NONE,
        skipped: [],
      });
    }
  }

  /** Closes the innermost container. A missing closing bracket is reported by the caller. */
  private closeContainer(frame: SequenceFrame | ObjectFrame, close: Token | undefined): void {
    if (frame.pending.length > 0) {
      // A malformed annotation has been reported already; only a whole one is also "dangling".
      const dangling = frame.pending.find(isComplete);
      if (dangling !== undefined) {
        this.report("XFER0502", dangling.open, "it is the last thing in its collection");
      }
      if (frame.kind === "sequence") {
        frame.items.push(errorNode(NO_TOKENS, take(frame)));
      } else {
        frame.pairs.push({
          key: undefined,
          value: undefined,
          annotations: take(frame),
          skipped: NO_TOKENS,
        });
      }
    }
    this.stack.pop();
    this.depth--;
    if (frame.kind === "sequence") {
      this.openSequences--;
    } else {
      this.openObjects--;
    }
    this.deliver(
      frame.kind === "sequence"
        ? {
            kind: "sequence",
            open: frame.open,
            close,
            items: frame.items,
            annotations: frame.annotations,
          }
        : {
            kind: "object",
            open: frame.open,
            close,
            pairs: frame.pairs,
            annotations: frame.annotations,
          },
    );
  }

  /** A finished value goes to the frame that was waiting for it. */
  private deliver(node: Node): void {
    const frame = this.top();
    switch (frame.kind) {
      case "doc":
        this.root = node;
        this.rootDone = true;
        break;
      case "sequence":
        frame.items.push(node);
        break;
      case "object":
        frame.pairs.push({
          key: frame.key,
          value: node,
          annotations: frame.pairAnnotations,
          skipped: frame.skipped.length === 0 ? NO_TOKENS : frame.skipped,
        });
        frame.key = undefined;
        frame.pairAnnotations = NONE;
        frame.skipped = [];
        frame.expectingValue = false;
        break;
      case "annotation":
        frame.value = node;
        frame.phase = "close";
        break;
      case "overflow":
        break; // an overflowing container takes its tokens directly and never waits for a value
    }
  }

  /** A container past the depth limit: keep its tokens, count its brackets, and say nothing more. */
  private onOverflow(frame: OverflowFrame, token: Token): boolean {
    if (token.kind === "eof") {
      this.report("XFER0405", frame.tokens[0] as Token, "the document ends inside it");
      this.stack.pop();
      this.deliver(errorNode(frame.tokens, frame.annotations));
      return false;
    }
    frame.tokens.push(token);
    if (token.kind === "lbrace" || token.kind === "lbrack") {
      frame.level++;
    } else if (token.kind === "rbrace" || token.kind === "rbrack") {
      frame.level--;
      if (frame.level === 0) {
        this.stack.pop();
        this.deliver(errorNode(frame.tokens, frame.annotations));
      }
    }
    return true;
  }

  // The document.

  private onDocument(frame: DocFrame, token: Token): boolean {
    if (this.rootDone) {
      if (token.kind === "eof") {
        this.eof = token;
        this.done = true;
        return false;
      }
      // Everything after the root is kept, unparsed, so the tree stays lossless. A token the lexer
      // already reported as malformed is not also reported as content after the root.
      if (token.kind !== "error" && !this.trailingReported) {
        this.trailingReported = true;
        this.report("XFER0402", token);
      }
      this.trailing.push(token);
      return true;
    }
    switch (token.kind) {
      case "annot-open":
        this.openAnnotation(token);
        return true;
      case "rbrace":
      case "rbrack":
        this.report("XFER0406", token, "there is nothing open to close");
        this.count(token);
        this.deliver(errorNode([token], take(frame)));
        return true;
      case "eof": {
        this.eof = token;
        this.done = true;
        if (frame.pending.length > 0) {
          // A malformed annotation has been reported already; only a whole one is also dangling.
          const dangling = frame.pending.find(isComplete);
          if (dangling !== undefined) {
            this.report("XFER0502", dangling.open, "the document ends after it");
          }
          this.root = errorNode(NO_TOKENS, take(frame));
        }
        this.report("XFER0401", token);
        return false;
      }
      default:
        return this.startValue(token, take(frame));
    }
  }

  // Sequences.

  private onSequence(frame: SequenceFrame, token: Token): boolean {
    switch (token.kind) {
      case "annot-open":
        this.openAnnotation(token);
        return true;
      case "rbrack":
        this.closeContainer(frame, token);
        return true;
      case "rbrace":
        return this.wrongCloser(frame, token);
      case "eof":
        this.report("XFER0405", frame.open, "expected `]`");
        this.closeContainer(frame, undefined);
        return false;
      default:
        return this.startValue(token, take(frame));
    }
  }

  /**
   * A closing bracket of the other kind. If a collection of that kind is open further out, the
   * bracket belongs to it, so this one is unterminated and is closed without the bracket, which
   * the next frame then reads. Otherwise the bracket is a mistake for this collection's own, and
   * closes it, so one slip is one error.
   */
  private wrongCloser(frame: SequenceFrame | ObjectFrame, token: Token): boolean {
    const wanted = frame.kind === "sequence" ? "]" : "}";
    // This frame is the other kind from the bracket, so the counter holds only outer collections.
    const outer = token.kind === "rbrace" ? this.openObjects : this.openSequences;
    if (outer > 0) {
      this.report("XFER0405", frame.open, `expected \`${wanted}\``);
      this.closeContainer(frame, undefined);
      return false;
    }
    this.report("XFER0406", token, `expected \`${wanted}\``);
    this.closeContainer(frame, token);
    return true;
  }

  // Objects.

  private onObject(frame: ObjectFrame, token: Token): boolean {
    switch (token.kind) {
      case "annot-open":
        this.openAnnotation(token);
        return true;
      case "rbrace":
        this.closeContainer(frame, token);
        return true;
      case "rbrack":
        return this.wrongCloser(frame, token);
      case "eof":
        this.report("XFER0405", frame.open, "expected `}`");
        this.closeContainer(frame, undefined);
        return false;
      case "annot-close":
        // Skipped, not read as a key: this is what is left when `<!` was forgotten, as in
        // `{ tag x !> a 1 }`, and reading it as a key would swallow the next key as its value.
        this.report("XFER0103", token, "`!>` closes an annotation, and none is open");
        frame.pairs.push({
          key: token,
          value: undefined,
          annotations: take(frame),
          skipped: NO_TOKENS,
        });
        return true;
      case "lbrace":
      case "lbrack":
        // A container where a key belongs. It is read as a value so its contents do not cascade.
        this.report("XFER0407", token, "a key is an identifier or a string");
        frame.key = undefined;
        frame.pairAnnotations = take(frame);
        frame.expectingValue = true;
        return this.startValue(token, NONE);
      case "identifier":
      case "string":
        this.takeKey(frame, token);
        return true;
      case "error":
        if (isStraySeparator(token)) {
          frame.pairs.push({
            key: token,
            value: undefined,
            annotations: take(frame),
            skipped: NO_TOKENS,
          });
          return true;
        }
        // The lexer reported it already; keep it as the key so its value is consumed quietly.
        frame.key = token;
        frame.pairAnnotations = take(frame);
        frame.expectingValue = true;
        return true;
      default:
        this.report(
          "XFER0407",
          token,
          `found ${token.kind === "keyword" ? "the keyword " : ""}${token.text}`,
        );
        frame.key = token;
        frame.pairAnnotations = take(frame);
        frame.expectingValue = true;
        return true;
    }
  }

  private takeKey(frame: ObjectFrame, token: Token): void {
    const text = keyText(token);
    if (frame.keys.has(text)) {
      this.report("XFER0403", token, `the key ${JSON.stringify(shorten(text))} is already used`);
    } else {
      frame.keys.add(text);
    }
    frame.key = token;
    frame.pairAnnotations = take(frame);
    frame.expectingValue = true;
  }

  private onObjectValue(frame: ObjectFrame, token: Token): boolean {
    switch (token.kind) {
      case "annot-open":
        this.report(
          "XFER0502",
          token,
          "an annotation goes before a key, not between a key and its value",
        );
        this.openAnnotation(token);
        return true;
      case "rbrace":
        this.missingValue(frame);
        this.closeContainer(frame, token);
        return true;
      case "eof":
        this.missingValue(frame);
        this.report("XFER0405", frame.open, "expected `}`");
        this.closeContainer(frame, undefined);
        return false;
      case "rbrack":
        this.missingValue(frame);
        return this.wrongCloser(frame, token);
      case "error":
        if (isStraySeparator(token)) {
          // `"a": 1` has a stray colon after its key; skip it and read the value that follows.
          frame.skipped.push(token);
          return true;
        }
        return this.startValue(token, take(frame));
      default:
        return this.startValue(token, take(frame));
    }
  }

  /** A key with no value: reports it, lists how the parser paired what it read, and records the pair. */
  private missingValue(frame: ObjectFrame): void {
    const key = frame.key;
    if (key !== undefined && SCALAR_KINDS.has(key.kind)) {
      const paired = frame.pairs.map(
        (p) => `${p.key === undefined ? "?" : shorten(keyText(p.key))}=${describe(p.value)}`,
      );
      paired.push(`${shorten(keyText(key))}=?`);
      const shown = paired.length > 8 ? ["...", ...paired.slice(-8)] : paired;
      this.report(
        "XFER0404",
        key,
        `a value is missing for ${JSON.stringify(shorten(keyText(key)))}; the parser paired ${shown.join(", ")}`,
      );
    }
    // An annotation after the key goes to `skipped`, so nothing is pending between a key and its value.
    frame.pairs.push({
      key,
      value: undefined,
      annotations: frame.pairAnnotations,
      skipped: frame.skipped.length === 0 ? NO_TOKENS : frame.skipped,
    });
    frame.key = undefined;
    frame.pairAnnotations = NONE;
    frame.skipped = [];
    frame.expectingValue = false;
  }

  // Annotations (specification 7).

  private openAnnotation(token: Token): void {
    if (this.annotationDepth > 0) {
      this.report("XFER0501", token, "an annotation's value cannot carry an annotation");
    }
    this.annotationDepth++;
    this.stack.push({
      kind: "annotation",
      open: token,
      name: undefined,
      value: undefined,
      close: undefined,
      phase: "name",
      pending: [],
      candidateHead: this.tokenCount === 1 && token.leading.every((t) => t.kind !== "comment"),
      outerObjects: this.openObjects,
      outerSequences: this.openSequences,
    });
    // Brackets inside the annotation's value are matched only with each other.
    this.openObjects = 0;
    this.openSequences = 0;
  }

  private malformed(frame: AnnotationFrame, what: string): void {
    this.report("XFER0506", frame.open, `the annotation ${what}`);
  }

  private onAnnotation(frame: AnnotationFrame, token: Token): boolean {
    switch (frame.phase) {
      case "name":
        // A token the lexer reported is kept as the name, so one fault is one error; an
        // annotation with such a name is not checked further (isComplete).
        if (token.kind === "identifier" || token.kind === "error") {
          frame.name = token;
          frame.phase = "value";
          return true;
        }
        this.malformed(frame, "has no name");
        if (token.kind === "annot-close") {
          frame.close = token;
          this.finishAnnotation(frame);
          return true;
        }
        // Leave the token for the enclosing frame; it is not part of this annotation.
        this.finishAnnotation(frame);
        return false;

      case "value":
        switch (token.kind) {
          case "annot-open":
            this.openAnnotation(token);
            return true;
          case "annot-close":
            this.malformed(frame, "has no value");
            frame.value = frame.pending.length > 0 ? errorNode(NO_TOKENS, take(frame)) : undefined;
            frame.close = token;
            this.finishAnnotation(frame);
            return true;
          case "rbrace":
          case "rbrack":
          case "eof":
            this.malformed(frame, "has no value");
            frame.value = frame.pending.length > 0 ? errorNode(NO_TOKENS, take(frame)) : undefined;
            this.finishAnnotation(frame);
            return false;
          default:
            return this.startValue(token, take(frame));
        }

      case "close":
        if (token.kind === "annot-close") {
          frame.close = token;
          this.finishAnnotation(frame);
          return true;
        }
        // An annotation takes one value. If the name is not one the specification defines, say
        // that first: `<! let x 1 !>` is a legacy form, and "unknown annotation" is the cause.
        if (frame.name !== undefined && !KNOWN_ANNOTATIONS.has(frame.name.text)) {
          this.report(
            "XFER0506",
            frame.open,
            `unknown annotation ${JSON.stringify(shorten(frame.name.text))}`,
          );
        } else {
          this.malformed(frame, "is not closed: expected `!>`");
        }
        this.finishAnnotation(frame);
        return false;
    }
  }

  private finishAnnotation(frame: AnnotationFrame): void {
    this.stack.pop();
    this.annotationDepth--;
    this.openObjects = frame.outerObjects;
    this.openSequences = frame.outerSequences;
    const node: AnnotationNode = {
      open: frame.open,
      name: frame.name,
      value: frame.value,
      close: frame.close,
    };
    // Only a complete annotation has a meaning to check; an incomplete one is already reported.
    const complete = isComplete(node);
    if (complete && this.isHead(frame, node)) {
      return;
    }
    if (complete) {
      this.validate(frame, node);
    }
    const lower = this.top();
    if (lower.kind === "object" && lower.expectingValue) {
      // After a key and before its value is not a place for an annotation (it was reported when
      // it opened). It is kept, in order, with whatever else was skipped there.
      lower.skipped.push(node);
    } else if (lower.kind !== "overflow") {
      lower.pending.push(node);
    }
  }

  /** The `xfer` head: first token of the document, nothing before it but whitespace. */
  private isHead(frame: AnnotationFrame, node: AnnotationNode): boolean {
    if (!frame.candidateHead || node.name?.text !== "xfer") {
      return false;
    }
    this.head = node;
    const value = node.value;
    const token = value?.kind === "scalar" ? value.token : undefined;
    if (token === undefined || token.kind !== "integer" || !/^(0|[1-9][0-9]*)$/.test(token.text)) {
      this.report(
        "XFER0504",
        frame.open,
        "the version is a plain whole number, as in <! xfer 1 !>",
      );
    } else {
      this.version = Number(token.text);
      if (token.text !== "1") {
        this.report(
          "XFER0504",
          frame.open,
          `version ${token.text} is not supported; this parser reads version 1`,
        );
      }
    }
    return true;
  }

  private validate(frame: AnnotationFrame, node: AnnotationNode): void {
    const name = node.name?.text ?? "";
    const value = node.value;
    const token = value?.kind === "scalar" ? value.token : undefined;
    const wrongType = (wants: string) =>
      this.report("XFER0506", frame.open, `\`${name}\` takes ${wants}`);
    switch (name) {
      case "xfer":
        this.report("XFER0503", frame.open, "it must be the first token of the document");
        break;
      case "id": {
        if (token?.kind !== "string") {
          wrongType("a string");
          break;
        }
        const id = token.content ?? "";
        if (this.ids.has(id)) {
          this.report(
            "XFER0505",
            frame.open,
            `the id ${JSON.stringify(shorten(id))} is already used`,
          );
        } else {
          this.ids.add(id);
        }
        break;
      }
      case "tag":
      case "lang":
        if (token === undefined || (token.kind !== "string" && token.kind !== "identifier")) {
          wrongType("a string or a symbol");
        }
        break;
      default:
        this.report("XFER0506", frame.open, `unknown annotation ${JSON.stringify(shorten(name))}`);
    }
  }
}
