import type { PlainOptions, XferValue } from "./types";
import { asNumber, MAX_SAFE } from "./value";

type Container = Extract<XferValue, { kind: "object" | "sequence" }>;

interface Frame {
  readonly container: Container;
  readonly keys: readonly string[];
  readonly kids: readonly XferValue[];
  readonly target: unknown[] | Record<string, unknown>;
  next: number;
}

function leaf(value: Exclude<XferValue, Container>, options?: PlainOptions): unknown {
  switch (value.kind) {
    case "string":
      return value.value;
    case "integer":
      return options?.integers === "bigint" || value.value > MAX_SAFE || value.value < -MAX_SAFE
        ? value.value
        : Number(value.value);
    case "fractional":
      return options?.fractionals === "lexeme" ? value.lexeme : asNumber(value).value;
    case "bool":
      return value.value;
    case "null":
      return null;
    case "symbol":
      return options?.symbols === "symbol-object"
        ? { kind: "symbol", name: value.name }
        : value.name;
    default:
      return value.lexeme;
  }
}

function open(container: Container): Frame {
  if (container.kind === "sequence") {
    return { container, keys: [], kids: container.items, target: [], next: 0 };
  }
  return {
    container,
    keys: [...container.entries.keys()],
    kids: [...container.entries.values()],
    target: {},
    next: 0,
  };
}

/**
 * A plain JavaScript projection of a value for code that wants data, not a model. Annotations are
 * dropped and a temporal becomes its lexeme. Objects are plain objects whose keys are defined with
 * `Object.defineProperty`, so a key such as `__proto__` is data and never changes a prototype.
 * Iterative, so depth cannot overflow the stack.
 */
export function toPlain(value: XferValue, options?: PlainOptions): unknown {
  if (value.kind !== "object" && value.kind !== "sequence") {
    return leaf(value, options);
  }
  const stack: Frame[] = [open(value)];
  const root = (stack[0] as Frame).target;
  for (;;) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.next === frame.kids.length) {
      stack.pop();
      if (stack.length === 0) {
        return root;
      }
      continue;
    }
    const index = frame.next++;
    const kid = frame.kids[index] as XferValue;
    let produced: unknown;
    if (kid.kind === "object" || kid.kind === "sequence") {
      const child = open(kid);
      stack.push(child);
      produced = child.target;
    } else {
      produced = leaf(kid, options);
    }
    if (Array.isArray(frame.target)) {
      frame.target.push(produced);
    } else {
      Object.defineProperty(frame.target, frame.keys[index] as string, {
        value: produced,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
}
