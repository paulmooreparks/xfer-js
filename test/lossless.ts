import type { AnnotationNode, Document, Node, PairNode, Token } from "../src/index";

type Item =
  | { readonly t: "token"; readonly token: Token }
  | { readonly t: "node"; readonly node: Node }
  | { readonly t: "annotation"; readonly annotation: AnnotationNode }
  | { readonly t: "pair"; readonly pair: PairNode };

/** Every token of a document in source order, ending with the eof token. Iterative. */
export function tokensInOrder(doc: Document): Token[] {
  const out: Token[] = [];
  const stack: Item[] = [{ t: "token", token: doc.eof }];
  // Pushed in reverse, so that the trailing tokens come out in order, before the eof token.
  for (let i = doc.trailing.length - 1; i >= 0; i--) {
    stack.push({ t: "token", token: doc.trailing[i] as Token });
  }
  if (doc.root) {
    stack.push({ t: "node", node: doc.root });
  }
  if (doc.head) {
    stack.push({ t: "annotation", annotation: doc.head });
  }

  // Items are pushed in reverse so that they pop in source order.
  const pushAll = (items: Item[]) => {
    for (let i = items.length - 1; i >= 0; i--) {
      stack.push(items[i] as Item);
    }
  };
  const annotations = (list: readonly AnnotationNode[]): Item[] =>
    list.map((annotation) => ({ t: "annotation", annotation }));

  while (stack.length > 0) {
    const item = stack.pop() as Item;
    switch (item.t) {
      case "token":
        out.push(item.token);
        break;
      case "annotation": {
        const a = item.annotation;
        const parts: Item[] = [{ t: "token", token: a.open }];
        if (a.name) {
          parts.push({ t: "token", token: a.name });
        }
        if (a.value) {
          parts.push({ t: "node", node: a.value });
        }
        if (a.close) {
          parts.push({ t: "token", token: a.close });
        }
        pushAll(parts);
        break;
      }
      case "pair": {
        const p = item.pair;
        const parts: Item[] = annotations(p.annotations);
        if (p.key) {
          parts.push({ t: "token", token: p.key });
        }
        for (const skipped of p.skipped) {
          parts.push(
            "kind" in skipped
              ? { t: "token", token: skipped }
              : { t: "annotation", annotation: skipped },
          );
        }
        if (p.value) {
          parts.push({ t: "node", node: p.value });
        }
        pushAll(parts);
        break;
      }
      case "node": {
        const n = item.node;
        const parts: Item[] = annotations(n.annotations);
        if (n.kind === "scalar") {
          parts.push({ t: "token", token: n.token });
        } else if (n.kind === "error") {
          for (const token of n.tokens) {
            parts.push({ t: "token", token });
          }
        } else {
          parts.push({ t: "token", token: n.open });
          if (n.kind === "object") {
            for (const pair of n.pairs) {
              parts.push({ t: "pair", pair });
            }
          } else {
            for (const node of n.items) {
              parts.push({ t: "node", node });
            }
          }
          if (n.close) {
            parts.push({ t: "token", token: n.close });
          }
        }
        pushAll(parts);
        break;
      }
    }
  }
  return out;
}

/** Rebuilds the source from the tree. Equals `doc.text` exactly when the tree is lossless. */
export function reconstruct(doc: Document): string {
  return tokensInOrder(doc)
    .map((t) => t.leading.map((trivia) => trivia.text).join("") + t.text)
    .join("");
}
