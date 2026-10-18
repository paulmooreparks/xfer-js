import { mulberry32, pick } from "./random.ts";

/** The suite's tagged form of a value (suite/tests/README.md). */
export type Tagged = Record<string, unknown>;

interface AnnotationModel {
  readonly text: string;
  readonly tagged: Tagged;
}

interface Annotated {
  readonly annotations: readonly AnnotationModel[];
  readonly node: Model;
}

export type Model =
  | { readonly t: "scalar"; readonly text: string; readonly tagged: Tagged }
  | { readonly t: "sequence"; readonly items: readonly Annotated[] }
  | {
      readonly t: "object";
      readonly pairs: readonly {
        readonly spelled: string;
        readonly key: string;
        readonly annotations: readonly AnnotationModel[];
        readonly value: Model;
      }[];
    };

export interface GeneratedDocument {
  readonly head: boolean;
  readonly root: Annotated;
}

const KEYS: readonly [string, string][] = [
  ["a", "a"],
  ["b", "b"],
  ["menu-id", "menu-id"],
  ["x.y", "x.y"],
  ['"first name"', "first name"],
  ['"true"', "true"],
  ["日本", "日本"],
  ["_k", "_k"],
  ['"{ braces }"', "{ braces }"],
  ['#"a "quoted" key"#', 'a "quoted" key'],
];

const SYMBOLS = ["dark", "light", "v1.2.3", "read-only", "naïve", "日本語", "_x", "infinity"];

/** Builds a random document model. Everything random is drawn here, so rendering is deterministic. */
export function generate(seed: number): GeneratedDocument {
  const random = mulberry32(seed);
  let nextId = 0;

  const chance = (p: number) => random() < p;

  const text = (alphabet: readonly string[], max: number) => {
    let s = "";
    for (let i = Math.floor(random() * max); i > 0; i--) {
      s += pick(random, alphabet);
    }
    return s;
  };

  const stringScalar = (): Model => {
    const choice = Math.floor(random() * 5);
    if (choice === 0) {
      return { t: "scalar", text: '""', tagged: { type: "string", value: "" } };
    }
    if (choice === 1) {
      // Content with inner quotes: a run of three or more quotes delimits it.
      const content = `${text(["a", " ", "b"], 3)} "${text(["x", " "], 3)}" ${text(["c", "\n"], 3)}`;
      return { t: "scalar", text: `"""${content}"""`, tagged: { type: "string", value: content } };
    }
    if (choice === 2) {
      // Content that begins and ends with a quote can only be written in the hash form.
      const content = `"${text(["a", " ", "#"], 4)}"`;
      // The closer is a quote followed by exactly m hashes, so m must exceed every hash run that
      // follows a quote in the content (specification 4.4).
      let m = 1;
      for (const run of content.matchAll(/"(#*)/g)) {
        m = Math.max(m, (run[1] as string).length + 1);
      }
      const hashes = "#".repeat(m);
      return {
        t: "scalar",
        text: `${hashes}"${content}"${hashes}`,
        tagged: { type: "string", value: content },
      };
    }
    const content = text(
      ["a", "b", " ", "\n", "\\", "<", "/", "{", "#", "é", "日", "!", "<!", "</"],
      8,
    );
    return { t: "scalar", text: `"${content}"`, tagged: { type: "string", value: content } };
  };

  const integerScalar = (): Model => {
    const n = BigInt(Math.floor(random() * 70000)) * (chance(0.5) ? 1n : 1_000_000_000_000n);
    const sign = chance(0.3) ? "-" : "";
    const value = sign === "-" ? -n : n;
    const form = Math.floor(random() * 5);
    const body =
      form === 0
        ? n.toString()
        : form === 1
          ? `0x${n.toString(16)}`
          : form === 2
            ? `0o${n.toString(8)}`
            : form === 3
              ? `0b${n.toString(2)}`
              : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
    return {
      t: "scalar",
      text: `${sign}${body}`,
      tagged: { type: "integer", value: value.toString() },
    };
  };

  const fractionalScalar = (): Model => {
    const forms = [
      "1.5",
      "0.25",
      "6.02e23",
      "1e5",
      "2.5E-3",
      "1_000.000_1",
      "-3.14",
      "0e0",
      "inf",
      "-inf",
      "nan",
    ];
    const lexeme = pick(random, forms);
    return {
      t: "scalar",
      text: lexeme,
      tagged: { type: "fractional", value: lexeme.replaceAll("_", "") },
    };
  };

  const scalar = (): Model => {
    switch (Math.floor(random() * 9)) {
      case 0:
        return integerScalar();
      case 1:
        return fractionalScalar();
      case 2:
      case 3:
        return stringScalar();
      case 4: {
        const name = pick(random, SYMBOLS);
        return { t: "scalar", text: name, tagged: { type: "symbol", value: name } };
      }
      case 5: {
        const word = pick(random, ["true", "false", "null"]);
        const tagged = word === "null" ? { type: "null" } : { type: "bool", value: word };
        return { t: "scalar", text: word, tagged };
      }
      default: {
        const [kind, lexeme] = pick(random, [
          ["date", "2025-08-01"],
          ["time", "09:30:00.250"],
          ["local-datetime", "2025-08-01T09:30:00"],
          ["datetime", "2025-08-01T09:30:00Z"],
          ["datetime", "2025-08-01T09:30:00+08:00"],
        ] as const);
        return { t: "scalar", text: lexeme, tagged: { type: kind, value: lexeme } };
      }
    }
  };

  const annotation = (): AnnotationModel => {
    switch (Math.floor(random() * 4)) {
      case 0: {
        const id = `id${nextId++}`;
        return {
          text: `<! id "${id}" !>`,
          tagged: { name: "id", value: { type: "string", value: id } },
        };
      }
      case 1: {
        const name = pick(random, SYMBOLS);
        return {
          text: `<! tag ${name} !>`,
          tagged: { name: "tag", value: { type: "symbol", value: name } },
        };
      }
      case 2:
        return {
          text: '<! tag "two words" !>',
          tagged: { name: "tag", value: { type: "string", value: "two words" } },
        };
      default:
        return {
          text: "<! lang javascript !>",
          tagged: { name: "lang", value: { type: "symbol", value: "javascript" } },
        };
    }
  };

  const annotations = (p: number): AnnotationModel[] => {
    const list: AnnotationModel[] = [];
    while (chance(p) && list.length < 3) {
      list.push(annotation());
    }
    return list;
  };

  const value = (depth: number, forceContainer = false): Model => {
    if (!forceContainer && (depth <= 0 || chance(0.4))) {
      return scalar();
    }
    if (chance(0.5)) {
      const items = Array.from({ length: Math.floor(random() * 5) }, () => ({
        annotations: annotations(0.2),
        node: value(depth - 1),
      }));
      return { t: "sequence", items };
    }
    const chosen = [...KEYS].sort(() => random() - 0.5).slice(0, Math.floor(random() * 5));
    return {
      t: "object",
      pairs: chosen.map(([spelled, key]) => ({
        spelled,
        key,
        annotations: annotations(0.2),
        value: value(depth - 1),
      })),
    };
  };

  return {
    head: chance(0.3),
    root: { annotations: annotations(0.2), node: value(4, chance(0.85)) },
  };
}

/** Chooses the text between tokens. `required` means two scalars would otherwise run together. */
export type Separator = (required: boolean) => string;

const SPACES = [
  " ",
  "\n",
  "  ",
  "\t",
  "\n   ",
  " </ a note /> ",
  "</ x />",
  "\n  </ multi\n line /> \n",
];

export function randomSeparator(random: () => number): Separator {
  return (required) => (!required && random() < 0.4 ? "" : pick(random, SPACES));
}

/** Every optional space removed and every required one a single space. */
export const tightSeparator: Separator = (required) => (required ? " " : "");

function renderAnnotated(item: Annotated, sep: Separator): string {
  const lead = item.annotations.map((a) => `${a.text}${sep(true)}`).join("");
  return lead + render(item.node, sep);
}

export function render(model: Model, sep: Separator): string {
  switch (model.t) {
    case "scalar":
      return model.text;
    case "sequence": {
      const body = model.items.map((i) => renderAnnotated(i, sep)).join(sep(true));
      return `[${sep(false)}${body}${sep(false)}]`;
    }
    case "object": {
      const body = model.pairs
        .map((p) => {
          const lead = p.annotations.map((a) => `${a.text}${sep(true)}`).join("");
          return `${lead}${p.spelled}${sep(true)}${render(p.value, sep)}`;
        })
        .join(sep(true));
      return `{${sep(false)}${body}${sep(false)}}`;
    }
  }
}

/** The whole document: optional head (after whitespace only), then the root. */
export function renderDocument(doc: GeneratedDocument, sep: Separator, leading: string): string {
  const head = doc.head ? `${leading}<! xfer 1 !>${sep(true)}` : sep(false);
  return `${head}${renderAnnotated(doc.root, sep)}${sep(false)}`;
}

function taggedAnnotated(item: Annotated): Tagged {
  const node = tagged(item.node);
  return item.annotations.length === 0
    ? node
    : { annotations: item.annotations.map((a) => a.tagged), ...node };
}

export function tagged(model: Model): Tagged {
  switch (model.t) {
    case "scalar":
      return model.tagged;
    case "sequence":
      return { type: "sequence", value: model.items.map(taggedAnnotated) };
    case "object":
      return {
        type: "object",
        value: Object.fromEntries(
          model.pairs.map((p) => {
            const value = tagged(p.value);
            return [
              p.key,
              p.annotations.length === 0
                ? value
                : { annotations: p.annotations.map((a) => a.tagged), ...value },
            ];
          }),
        ),
      };
  }
}

export function taggedDocument(doc: GeneratedDocument): Tagged {
  const root = taggedAnnotated(doc.root);
  return doc.head ? { xfer: 1, root } : { root };
}
