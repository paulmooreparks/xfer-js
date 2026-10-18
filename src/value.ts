import type { AnnotationNode, Document, Node, Token, XferValue } from "./types";

export function parseInteger(lexeme: string): bigint {
  const negative = lexeme.startsWith("-");
  const body = (negative ? lexeme.slice(1) : lexeme).replaceAll("_", "");
  // BigInt reads the 0x, 0o and 0b prefixes, which the lexer has already checked are lowercase.
  const magnitude = BigInt(body);
  return negative ? -magnitude : magnitude;
}

/** The value a scalar token denotes, without annotations. Undefined for a token that is not a value. */
function scalar(token: Token): XferValue | undefined {
  switch (token.kind) {
    case "string":
      return { kind: "string", value: token.content ?? "" };
    case "integer":
      return { kind: "integer", value: parseInteger(token.text), lexeme: token.text };
    case "fractional":
      return { kind: "fractional", lexeme: token.text };
    case "identifier":
      return { kind: "symbol", name: token.text };
    case "date":
    case "time":
    case "local-datetime":
    case "datetime":
      return { kind: token.kind, lexeme: token.text };
    case "keyword":
      switch (token.keyword) {
        case "true":
          return { kind: "bool", value: true };
        case "false":
          return { kind: "bool", value: false };
        case "null":
          return { kind: "null" };
        case "inf":
        case "-inf":
        case "nan":
          return { kind: "fractional", lexeme: token.keyword };
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

function annotationsOf(
  list: readonly AnnotationNode[],
): { name: string; value: XferValue }[] | undefined {
  const out: { name: string; value: XferValue }[] = [];
  for (const a of list) {
    // Only a scalar can be an annotation's value in a document that parsed without errors.
    if (a.name === undefined || a.value === undefined || a.value.kind !== "scalar") {
      return undefined;
    }
    const value = scalar(a.value.token);
    if (value === undefined) {
      return undefined;
    }
    out.push({ name: a.name.text, value });
  }
  return out;
}

function annotate(
  value: XferValue,
  list: readonly AnnotationNode[],
  before: readonly AnnotationNode[] = [],
): XferValue | undefined {
  const all = annotationsOf([...before, ...list]);
  if (all === undefined) {
    return undefined;
  }
  return all.length === 0 ? value : { ...value, annotations: all };
}

interface Frame {
  readonly node: Extract<Node, { kind: "object" | "sequence" }>;
  readonly kids: readonly Node[];
  readonly keys: readonly string[];
  readonly pairAnnotations: readonly (readonly AnnotationNode[])[];
  next: number;
  readonly done: XferValue[];
}

function open(node: Frame["node"]): Frame | undefined {
  if (node.kind === "sequence") {
    return { node, kids: node.items, keys: [], pairAnnotations: [], next: 0, done: [] };
  }
  const kids: Node[] = [];
  const keys: string[] = [];
  const pairAnnotations: (readonly AnnotationNode[])[] = [];
  for (const pair of node.pairs) {
    if (pair.key === undefined || pair.value === undefined) {
      return undefined;
    }
    kids.push(pair.value);
    keys.push(pair.key.kind === "string" ? (pair.key.content ?? "") : pair.key.text);
    pairAnnotations.push(pair.annotations);
  }
  return { node, kids, keys, pairAnnotations, next: 0, done: [] };
}

function finish(frame: Frame): XferValue | undefined {
  const { node } = frame;
  if (node.kind === "sequence") {
    return annotate({ kind: "sequence", items: frame.done }, node.annotations);
  }
  const entries = new Map<string, XferValue>();
  for (let i = 0; i < frame.keys.length; i++) {
    const key = frame.keys[i] as string;
    const member = frame.done[i] as XferValue;
    // An annotation before a pair describes the pair's value; there is no pair in the value model.
    const annotated = annotate(member, [], frame.pairAnnotations[i] ?? []);
    if (annotated === undefined) {
      return undefined;
    }
    // A repeated key is a diagnostic, and the later value wins.
    entries.set(key, annotated);
  }
  return annotate({ kind: "object", entries }, node.annotations);
}

/**
 * The value model of a parsed document, or undefined when the tree holds an error, a missing
 * value, or an unclosed container. Iterative, so depth cannot overflow the stack.
 */
export function toValue(tree: Document): XferValue | undefined {
  const stack: Frame[] = [];
  let pending: Node | undefined = tree.root;
  let produced: XferValue | undefined;
  let haveProduced = false;
  // Anything after the root is an error by construction, whether the parser reported it as
  // content after the root or the lexer reported it as malformed.
  if (pending === undefined || tree.trailing.length > 0) {
    return undefined;
  }

  for (;;) {
    if (pending !== undefined) {
      const node: Node = pending;
      pending = undefined;
      if (node.kind === "error") {
        return undefined;
      }
      if (node.kind === "scalar") {
        const value = scalar(node.token);
        produced = value === undefined ? undefined : annotate(value, node.annotations);
        if (produced === undefined) {
          return undefined;
        }
        haveProduced = true;
      } else {
        if (node.close === undefined) {
          return undefined;
        }
        const frame = open(node);
        if (frame === undefined) {
          return undefined;
        }
        stack.push(frame);
      }
    }
    if (haveProduced) {
      const parent = stack[stack.length - 1];
      if (parent === undefined) {
        return produced;
      }
      parent.done.push(produced as XferValue);
      haveProduced = false;
    }
    const top = stack[stack.length - 1];
    if (top === undefined) {
      return undefined;
    }
    if (top.next < top.kids.length) {
      pending = top.kids[top.next++];
    } else {
      stack.pop();
      produced = finish(top);
      if (produced === undefined) {
        return undefined;
      }
      haveProduced = true;
    }
  }
}
