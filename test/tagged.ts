import type { ParseResult, XferObject, XferSequence, XferValue } from "../src/index";

type Container = XferObject | XferSequence;

interface Frame {
  readonly value: Container;
  readonly keys: readonly string[];
  readonly kids: readonly XferValue[];
  next: number;
  readonly done: unknown[];
}

function leaf(v: Exclude<XferValue, Container>): Record<string, unknown> {
  switch (v.kind) {
    case "string":
      return { type: "string", value: v.value };
    case "integer":
      return { type: "integer", value: v.value.toString() };
    case "fractional":
      return { type: "fractional", value: v.lexeme.replaceAll("_", "") };
    case "bool":
      return { type: "bool", value: String(v.value) };
    case "null":
      return { type: "null" };
    case "symbol":
      return { type: "symbol", value: v.name };
    case "date":
    case "time":
    case "local-datetime":
    case "datetime":
      return { type: v.kind, value: v.lexeme };
  }
}

function annotate(v: XferValue, node: Record<string, unknown>): Record<string, unknown> {
  if (v.annotations === undefined) {
    return node;
  }
  // Annotation values carry no annotations, so this recursion is one level deep.
  const annotations = v.annotations.map((a) => ({ name: a.name, value: toTagged(a.value) }));
  return { annotations, ...node };
}

function finish(frame: Frame): Record<string, unknown> {
  if (frame.value.kind === "sequence") {
    return annotate(frame.value, { type: "sequence", value: frame.done });
  }
  const members = Object.fromEntries(frame.keys.map((k, i) => [k, frame.done[i]]));
  return annotate(frame.value, { type: "object", value: members });
}

function open(v: Container): Frame {
  if (v.kind === "object") {
    return {
      value: v,
      keys: [...v.entries.keys()],
      kids: [...v.entries.values()],
      next: 0,
      done: [],
    };
  }
  return { value: v, keys: [], kids: v.items, next: 0, done: [] };
}

/**
 * Converts a value to the tagged form the conformance suite uses (see suite/tests/README.md).
 * Iterative, so a document at the depth limit cannot overflow the stack.
 */
export function toTagged(root: XferValue): unknown {
  const stack: Frame[] = [];
  let pending: XferValue | undefined = root;
  let produced: unknown;
  let haveProduced = false;

  for (;;) {
    if (pending !== undefined) {
      const v: XferValue = pending;
      pending = undefined;
      if (v.kind === "object" || v.kind === "sequence") {
        stack.push(open(v));
      } else {
        produced = annotate(v, leaf(v));
        haveProduced = true;
      }
    }
    if (haveProduced) {
      const parent = stack[stack.length - 1];
      if (parent === undefined) {
        return produced;
      }
      parent.done.push(produced);
      haveProduced = false;
    }
    const top = stack[stack.length - 1];
    if (top === undefined) {
      throw new Error("toTagged: empty stack");
    }
    if (top.next < top.kids.length) {
      pending = top.kids[top.next++];
    } else {
      stack.pop();
      produced = finish(top);
      haveProduced = true;
    }
  }
}

/** The document form: `{"xfer": n, "root": ...}`, with `xfer` present only when the source had a head. */
export function toTaggedDocument(result: ParseResult): unknown {
  if (result.value === undefined) {
    throw new Error("toTaggedDocument: the parse produced no value");
  }
  const root = toTagged(result.value);
  return result.tree.head === undefined ? { root } : { xfer: result.version, root };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * The member names of every object in a tagged structure, in traversal order. Structural equality
 * ignores key order, but the specification makes object member order normative, so the suite
 * runner compares this as well. (JavaScript hoists integer-like keys, so those can only be
 * checked through the canonical text.)
 */
export function memberOrder(tagged: unknown): string[][] {
  const out: string[][] = [];
  const stack: unknown[] = [tagged];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        stack.push(node[i]);
      }
    } else if (isRecord(node)) {
      if (node.type === "object" && isRecord(node.value)) {
        const keys = Object.keys(node.value);
        out.push(keys);
        for (let i = keys.length - 1; i >= 0; i--) {
          stack.push(node.value[keys[i] as string]);
        }
        stack.push(node.annotations);
      } else {
        for (const key of Object.keys(node).reverse()) {
          stack.push(node[key]);
        }
      }
    }
  }
  return out;
}
