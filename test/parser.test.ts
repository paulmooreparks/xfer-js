import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/index";
import { parse, parseValue, XferError } from "../src/index";
import { resolveLimits } from "../src/limits";
import { parseDocument } from "../src/parser";
import { toValue } from "../src/value";
import { loadCases } from "./cases.ts";
import {
  generate,
  randomSeparator,
  renderDocument,
  taggedDocument,
  tightSeparator,
} from "./generator.ts";
import { reconstruct } from "./lossless.ts";
import { mulberry32, pick } from "./random.ts";
import { memberOrder, toTagged, toTaggedDocument } from "./tagged.ts";

const defaults = resolveLimits();
const encode = (s: string) => new TextEncoder().encode(s);
const codes = (text: string) => parse(text).diagnostics.map((d) => d.code);
const at = (d: Diagnostic | undefined) => `${d?.start.line}:${d?.start.column}`;

describe("the suite, through the parser", () => {
  const { valid, invalid } = loadCases();

  it("gives every valid document the value model the suite states", () => {
    for (const c of valid) {
      const result = parse(c.input);
      expect(
        result.diagnostics.map((d) => `${d.code} ${at(d)} ${d.message}`),
        c.id,
      ).toEqual([]);
      const actual = toTaggedDocument(result);
      expect(actual, c.id).toEqual(c.value);
      expect(memberOrder(actual), c.id).toEqual(memberOrder(c.value));
    }
  });

  it("keeps the tree lossless for every case, valid or not", () => {
    for (const c of [...valid, ...invalid]) {
      const { tree } = parse(c.input);
      expect(reconstruct(tree), c.id).toBe(tree.text);
    }
  });

  it("gives the same result for the same document as bytes or as a string", () => {
    for (const c of [...valid, ...invalid]) {
      if (typeof c.input !== "string") {
        continue;
      }
      const fromString = parse(c.input);
      const fromBytes = parse(encode(c.input));
      expect(fromBytes.diagnostics, c.id).toEqual(fromString.diagnostics);
      expect(fromBytes.ok, c.id).toBe(fromString.ok);
      expect(fromBytes.version, c.id).toBe(fromString.version);
    }
  });

  it("rejects every invalid case", () => {
    for (const c of invalid) {
      expect(parse(c.input).ok, c.id).toBe(false);
    }
  });
});

describe("parse, results", () => {
  it("has a value exactly when there is no error", () => {
    const good = parse("{ a 1 }");
    expect(good.ok).toBe(true);
    expect(good.value?.kind).toBe("object");
    const bad = parse("{ a }");
    expect(bad.ok).toBe(false);
    expect(bad.value).toBeUndefined();
    expect(bad.tree.root).toBeDefined();
  });

  it("orders diagnostics by position", () => {
    const { diagnostics } = parse("[ ~ 1__0 { a ] ");
    const offsets = diagnostics.map((d) => d.start.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(diagnostics.length).toBeGreaterThan(2);
  });

  it("gives every diagnostic a range that does not run backwards", () => {
    for (const text of ["[ ~ 1__0 { a ] ", '"open', "{ a", "<! tag", "}"]) {
      for (const d of parse(text).diagnostics) {
        expect(d.end.offset, text).toBeGreaterThanOrEqual(d.start.offset);
      }
    }
  });

  it("returns a tree even when the input could not be read", () => {
    const result = parse(new Uint8Array([0xff]));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["XFER0701"]);
    expect(result.tree.root).toBeUndefined();
    expect(result.tree.text).toBe("");
  });
});

describe("parseValue", () => {
  it("returns the value", () => {
    expect(parseValue("[ 1 2 ]").kind).toBe("sequence");
  });

  it("throws an XferError carrying every diagnostic", () => {
    let thrown: unknown;
    try {
      parseValue("{ a 1 a 2 b }");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(XferError);
    const error = thrown as XferError;
    expect(error.diagnostics.map((d) => d.code)).toEqual(["XFER0403", "XFER0404"]);
    expect(error.message).toContain("XFER0403 at 1:7");
    expect(error.message).toContain("1 more");
  });
});

describe("the xfer head", () => {
  it("records the version and the head, and is not an annotation of the root", () => {
    const result = parse("<! xfer 1 !> 1");
    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    expect(result.tree.head?.name?.text).toBe("xfer");
    expect(result.value?.annotations).toBeUndefined();
  });

  it("defaults to version 1 when absent", () => {
    const result = parse("1");
    expect(result.version).toBe(1);
    expect(result.tree.head).toBeUndefined();
  });

  it("rejects a version this parser does not read, and still reports it", () => {
    const result = parse("<! xfer 99 !> 1");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["XFER0504"]);
    expect(result.version).toBe(99);
  });

  it("requires a plain whole number", () => {
    for (const bad of ['"1"', "1.0", "0x1", "-1", "1_0", "one"]) {
      expect(codes(`<! xfer ${bad} !> 1`), bad).toContain("XFER0504");
    }
  });

  it("must be the first token, and a comment before it counts as a token", () => {
    expect(codes("</ c /> <! xfer 1 !> 1")).toEqual(["XFER0503"]);
    expect(codes("<! xfer 1 !> <! xfer 1 !> 1")).toEqual(["XFER0503"]);
    expect(codes("\n  <! xfer 1 !> 1")).toEqual([]);
    expect(codes("[ <! xfer 1 !> 1 ]")).toEqual(["XFER0503"]);
  });

  it("may be followed by annotations on the root", () => {
    const result = parse('<! xfer 1 !> <! tag "t" !> [ ]');
    expect(result.ok).toBe(true);
    expect(result.value?.annotations?.map((a) => a.name)).toEqual(["tag"]);
  });
});

describe("annotations", () => {
  it("attach to the next element in a sequence and at the root", () => {
    const result = parse('<! id "r" !> [ <! tag a !> 1 2 ]');
    expect(result.ok).toBe(true);
    const root = result.value;
    expect(root?.annotations?.map((a) => a.name)).toEqual(["id"]);
    const items = root?.kind === "sequence" ? root.items : [];
    expect(items[0]?.annotations?.map((a) => a.name)).toEqual(["tag"]);
    expect(items[1]?.annotations).toBeUndefined();
  });

  it("attach to the pair in an object, and the value model puts them on the value", () => {
    const result = parse('{ <! id "k" !> <! tag t !> a 1 b 2 }');
    expect(result.ok).toBe(true);
    const root = result.tree.root;
    expect(root?.kind === "object" && root.pairs[0]?.annotations.length).toBe(2);
    const entries = result.value?.kind === "object" ? result.value.entries : new Map();
    expect(entries.get("a")?.annotations?.map((a: { name: string }) => a.name)).toEqual([
      "id",
      "tag",
    ]);
    expect(entries.get("b")?.annotations).toBeUndefined();
  });

  it("report a dangling annotation where it ends a collection or a document", () => {
    expect(codes("[ 1 <! tag a !> ]")).toEqual(["XFER0502"]);
    expect(codes("{ a 1 <! tag a !> }")).toEqual(["XFER0502"]);
    expect(codes("<! tag a !>")).toEqual(["XFER0502", "XFER0401"]);
  });

  it("keep a dangling annotation in the tree, so it stays lossless", () => {
    const { tree } = parse("{ a 1 <! tag x !> }");
    const root = tree.root;
    const last = root?.kind === "object" ? root.pairs[1] : undefined;
    expect(last?.key).toBeUndefined();
    expect(last?.annotations.length).toBe(1);
    expect(reconstruct(tree)).toBe("{ a 1 <! tag x !> }");
  });

  it("do not belong between a key and its value", () => {
    const result = parse("{ a <! tag x !> 1 }");
    expect(result.diagnostics.map((d) => `${d.code} ${at(d)}`)).toEqual(["XFER0502 1:5"]);
    expect(reconstruct(result.tree)).toBe("{ a <! tag x !> 1 }");
  });

  it("report an annotation after the root as content after the root", () => {
    expect(codes("1 <! tag x !>")).toEqual(["XFER0402"]);
  });

  it("reject an annotation inside an annotation value, at any depth", () => {
    expect(codes('<! tag <! id "x" !> y !> 1')).toEqual(["XFER0501"]);
    // Ordered by position: the unknown annotation `x` opens before the one inside its value.
    expect(codes("<! x [ <! tag a !> 1 ] !> 1")).toEqual(["XFER0506", "XFER0501"]);
  });

  it("know the three defined names and what each takes", () => {
    expect(codes('<! id "a" !> <! tag t !> <! tag "s" !> <! lang javascript !> 1')).toEqual([]);
    expect(codes("<! id 5 !> 1")).toEqual(["XFER0506"]);
    expect(codes("<! id a !> 1")).toEqual(["XFER0506"]);
    expect(codes("<! tag true !> 1")).toEqual(["XFER0506"]);
    expect(codes("<! tag [ a ] !> 1")).toEqual(["XFER0506"]);
    expect(codes("<! lang 1 !> 1")).toEqual(["XFER0506"]);
  });

  it("report a repeated id, but allow repeated tags", () => {
    expect(codes('[ <! id "x" !> 1 <! id "x" !> 2 ]')).toEqual(["XFER0505"]);
    expect(codes("[ <! tag a !> 1 <! tag a !> 2 ]")).toEqual([]);
  });

  it("treat any other name as unknown, whatever its value", () => {
    expect(codes('<! document { version "1" } !> 1')).toEqual(["XFER0506"]);
    // The legacy form `<! let x 1 !>` has two values, so it never closes; the name is reported.
    expect(codes("<! let x 1 !> 1")).toEqual(["XFER0506", "XFER0402"]);
    expect(parse("<! let x 1 !> 1").diagnostics[0]?.message).toContain('unknown annotation "let"');
  });

  it("report a malformed annotation once, and keep what follows", () => {
    expect(codes("<! !> 1")).toEqual(["XFER0506"]);
    expect(codes("<! tag !> 1")).toEqual(["XFER0506"]);
    // Not closed: reported once, and not also called dangling.
    expect(codes("{ <! tag x } ")).toEqual(["XFER0506"]);
    expect(codes("<! tag x 1 !> 2")).toEqual(["XFER0506", "XFER0402"]);
    expect(codes("<! 1 2 !> 3")).toEqual(["XFER0506", "XFER0402"]);
  });

  it("never lose a token, however the annotation is broken", () => {
    for (const text of [
      "<! !> 1",
      "<! tag !> 1",
      "{ <! tag x } ",
      "<! tag x 1 !> 2",
      "<!",
      "<! tag",
      "[ <! a <! b",
    ]) {
      const { tree } = parse(text);
      expect(reconstruct(tree), text).toBe(text);
    }
  });
});

describe("keys and values in objects", () => {
  it("report a missing value, listing how the parser paired what it read", () => {
    const [d] = parse("{ a b c d e f g }").diagnostics;
    expect(d?.code).toBe("XFER0404");
    expect(at(d)).toBe("1:15");
    expect(d?.message).toContain("a=symbol b, c=symbol d, e=symbol f, g=?");
  });

  it("shorten the pairing list of a long object", () => {
    const keys = Array.from({ length: 20 }, (_, i) => `k${i} v${i}`).join(" ");
    const [d] = parse(`{ ${keys} last }`).diagnostics;
    expect(d?.message).toContain("...");
    expect(d?.message).toContain("last=?");
    expect(d?.message).not.toContain("k0=");
  });

  it("shorten a long key in a message without cutting a surrogate pair in two", () => {
    const key = "😀".repeat(15);
    const [d] = parse(`{ "${key}" 1 x }`).diagnostics;
    expect(d?.code).toBe("XFER0404");
    // The message is well-formed text: no lone surrogate where the key was cut.
    expect(d?.message.isWellFormed()).toBe(true);
    expect(d?.message).toContain(`${"😀".repeat(10)}...`);
  });

  it("read a string key and a bare key as the same key", () => {
    expect(codes('{ a 1 "a" 2 }')).toEqual(["XFER0403"]);
    expect(codes('{ "first name" 1 "first name" 2 }')).toEqual(["XFER0403"]);
  });

  it("keep both pairs of a repeated key in the tree, and the later value in the value model", () => {
    const { tree } = parse("{ a 1 a 2 }");
    const root = tree.root;
    expect(root?.kind === "object" && root.pairs.length).toBe(2);
    const value = toValue(tree);
    const entries = value?.kind === "object" ? value.entries : new Map();
    expect([...entries.keys()]).toEqual(["a"]);
    expect(entries.get("a")).toMatchObject({ kind: "integer", lexeme: "2" });
  });

  it("report a token that cannot be a key, then read its value without cascading", () => {
    expect(codes("{ true 1 }")).toEqual(["XFER0407"]);
    expect(codes("{ 2025 x }")).toEqual(["XFER0407"]);
    expect(codes("{ 1.5 x b 2 }")).toEqual(["XFER0407"]);
    expect(codes("{ 2025-08-01 x }")).toEqual(["XFER0407"]);
  });

  it("read a container where a key belongs as a value, so its contents do not cascade", () => {
    expect(codes("{ { a 1 } b 2 }")).toEqual(["XFER0407"]);
    expect(codes("{ [ 1 2 3 ] b 2 }")).toEqual(["XFER0407"]);
  });

  it("report one fault once, not once per token it breaks", () => {
    expect(codes("{ a ~true b 1 }")).toEqual(["XFER0103"]);
    expect(codes("[ 1-2 ]")).toEqual(["XFER0101"]);
    expect(codes("{ a 1-2 }")).toEqual(["XFER0101"]);
    expect(codes("[ 1__0 2 ]")).toEqual(["XFER0302"]);
    expect(codes("1-2")).toEqual(["XFER0101"]);
  });

  it("skip the commas and colons of JSON and YAML instead of shifting every pair after them", () => {
    // Each stray separator is one error with a hint; the keys and values around it are still read.
    expect(codes('{ "a": 1, "b": 2 }')).toEqual(["XFER0101", "XFER0101", "XFER0101"]);
    expect(codes('{"a":1,"b":2}')).toEqual(["XFER0101"]);
    expect(codes('{ "a" : 1 , "b" : 2 }')).toEqual(["XFER0103", "XFER0103", "XFER0103"]);
    expect(codes("{ a 1, b 2 }")).toEqual(["XFER0101"]);
    expect(codes("{ a: 1 b: 2 }")).toEqual(["XFER0101", "XFER0101"]);
    const result = parse('{ "a": 1, "b": 2 }');
    const root = result.tree.root;
    expect(root?.kind === "object" && root.pairs.map((p) => p.value?.kind)).toEqual([
      "scalar",
      undefined,
      "scalar",
    ]);
    expect(reconstruct(result.tree)).toBe('{ "a": 1, "b": 2 }');
  });

  it("keep the hint on each stray separator", () => {
    const messages = parse('{ "a": 1, "b": 2 }').diagnostics.map((d) => d.message);
    expect(messages[0]).toContain("colon");
    expect(messages[1]).toContain("commas");
  });

  it("do not report a malformed token after the root as content after the root as well", () => {
    expect(codes("{ } ~")).toEqual(["XFER0103"]);
    expect(codes("{ } ~ 1")).toEqual(["XFER0103", "XFER0402"]);
  });

  it("close a collection with the wrong bracket, and say what was expected", () => {
    const [d] = parse("{ a 1 ]").diagnostics;
    expect(d?.code).toBe("XFER0406");
    expect(d?.message).toContain("expected `}`");
    // One slip is one error: the wrong bracket closes the collection it was meant for.
    expect(codes("{ a 1 ]")).toEqual(["XFER0406"]);
    expect(codes("[ 1 }")).toEqual(["XFER0406"]);
    expect(codes("{ a ]")).toEqual(["XFER0404", "XFER0406"]);
    expect(parse("{ a 1 ]").ok).toBe(false);
  });

  it("let a bracket that fits an outer collection end the inner ones, each reported once", () => {
    // The `]` belongs to the sequence, so the object is unterminated and the sequence closes.
    expect(codes("[ { a 1 ] 2")).toEqual(["XFER0405", "XFER0402"]);
    expect(codes("[ { a 1 ]")).toEqual(["XFER0405"]);
    expect(codes("[ [ { a 1 ] ]")).toEqual(["XFER0405"]);
    expect(codes("{ a [ 1 } ")).toEqual(["XFER0405"]);
  });

  it("report an unclosed collection once, at its opening bracket", () => {
    const [d] = parse("[ 1 2").diagnostics;
    expect([d?.code, at(d)]).toEqual(["XFER0405", "1:1"]);
    expect(codes("{ a { b [ 1")).toEqual(["XFER0405", "XFER0405", "XFER0405"]);
  });
});

describe("the document", () => {
  it("takes any value as its root, and exactly one", () => {
    expect(codes("42")).toEqual([]);
    expect(codes('"text"')).toEqual([]);
    expect(codes("null")).toEqual([]);
    expect(codes("1 2")).toEqual(["XFER0402"]);
    expect(codes("{ } { }")).toEqual(["XFER0402"]);
  });

  it("keeps everything after the root, and reports it once", () => {
    const result = parse("1 2 3 <! tag x !>");
    expect(result.diagnostics.map((d) => `${d.code} ${at(d)}`)).toEqual(["XFER0402 1:3"]);
    expect(result.tree.trailing.map((t) => t.text)).toEqual(["2", "3", "<!", "tag", "x", "!>"]);
  });

  it("is empty only when nothing but trivia is there", () => {
    expect(codes("")).toEqual(["XFER0401"]);
    expect(codes("  </ c />  \n")).toEqual(["XFER0401"]);
  });

  it("takes a stray closing bracket as the root, without also saying there is none", () => {
    expect(codes("]")).toEqual(["XFER0406"]);
    expect(codes("}")).toEqual(["XFER0406"]);
    expect(codes("!>")).toEqual(["XFER0103"]);
  });
});

describe("limits", () => {
  const deep = (n: number) => "[".repeat(n) + "]".repeat(n);

  it("accept the minimum depth and report the next level once", () => {
    expect(parse(deep(256)).ok).toBe(true);
    const result = parse(deep(1000));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["XFER0602"]);
    expect(result.diagnostics[0]?.start.offset).toBe(256);
  });

  it("apply a depth limit the caller raises, without recursion", () => {
    const limits = { ...defaults, depth: 1_000_000 };
    const text = deep(100_000);
    const diagnostics: Diagnostic[] = [];
    const { tree } = parseDocument(text, limits, diagnostics);
    expect(diagnostics).toEqual([]);
    const value = toValue(tree);
    expect(value?.kind).toBe("sequence");
    expect(toTagged(value as NonNullable<typeof value>)).toBeTypeOf("object");
    expect(reconstruct(tree)).toBe(text);
  });

  it("count every element against the element limit, and report it once", () => {
    const limits = { ...defaults, elements: 3 };
    const diagnostics: Diagnostic[] = [];
    parseDocument("[ 1 2 3 4 5 6 ]", limits, diagnostics);
    expect(diagnostics.map((d) => d.code)).toEqual(["XFER0605"]);
  });

  it("report a delimiter run over the limit through the whole parse", () => {
    expect(parse(`${'"'.repeat(65)}x${'"'.repeat(65)}`).diagnostics.map((d) => d.code)).toEqual([
      "XFER0604",
    ]);
  });
});

describe("random documents", () => {
  const SEEDS = 1500;

  it("parse to exactly the model they were built from", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = generate(seed);
      const random = mulberry32(seed * 7919);
      const sep = randomSeparator(random);
      // Before the head there may be whitespace but no comment, so the head is the first token.
      const leading = pick(random, ["", " ", "\n  ", "\t"]);
      const text = renderDocument(doc, sep, leading);
      const result = parse(text);
      const where = `seed ${seed}: ${JSON.stringify(text)}`;
      expect(
        result.diagnostics.map((d) => `${d.code} ${at(d)} ${d.message}`),
        where,
      ).toEqual([]);
      const expected = taggedDocument(doc);
      const actual = toTaggedDocument(result);
      expect(actual, where).toEqual(expected);
      expect(memberOrder(actual), where).toEqual(memberOrder(expected));
      expect(reconstruct(result.tree), where).toBe(result.tree.text);
    }
  });

  it("parse the same with every optional space removed, strings and comments included", () => {
    // The whitespace invariant: whitespace beside a bracket is optional, so removing it must not
    // change the value. The tight text is rendered from the model, so no string is touched.
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = generate(seed);
      const tight = renderDocument(doc, tightSeparator, "");
      const result = parse(tight);
      const where = `seed ${seed}: ${JSON.stringify(tight)}`;
      expect(result.diagnostics, where).toEqual([]);
      expect(toTaggedDocument(result), where).toEqual(taggedDocument(doc));
    }
  });

  it("cover what they claim to cover", () => {
    // A guard on the generator itself: if it stops producing a feature, this fails, instead of
    // the property tests above quietly checking less than they say.
    const seen = {
      annotated: 0,
      rootAnnotated: 0,
      manyAnnotations: 0,
      idAnnotation: 0,
      langAnnotation: 0,
      stringKey: 0,
      hashString: 0,
      tripleQuoteString: 0,
      radixInteger: 0,
      underscoreNumber: 0,
      special: 0,
      nestedContainer: 0,
      comment: 0,
      scalarRoot: 0,
      head: 0,
    };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = generate(seed);
      const text = renderDocument(doc, randomSeparator(mulberry32(seed * 7919)), "");
      seen.annotated += /<! (id|tag|lang)/.test(text) ? 1 : 0;
      seen.rootAnnotated += doc.root.annotations.length > 0 ? 1 : 0;
      seen.manyAnnotations += /<![\s\S]*?!>\s*<!/.test(text) ? 1 : 0;
      seen.idAnnotation += text.includes("<! id ") ? 1 : 0;
      seen.langAnnotation += text.includes("<! lang ") ? 1 : 0;
      seen.stringKey += /(^|[\s{])"[a-z{ ]+"\s/.test(text) ? 1 : 0;
      seen.hashString += text.includes('#"') ? 1 : 0;
      seen.tripleQuoteString += text.includes('"""') ? 1 : 0;
      seen.radixInteger += /0[xob][0-9a-f]/.test(text) ? 1 : 0;
      seen.underscoreNumber += /\d_\d/.test(text) ? 1 : 0;
      seen.special += /\b(inf|nan)\b/.test(text) ? 1 : 0;
      seen.nestedContainer += /[[{][\s\S]*[[{]/.test(text) ? 1 : 0;
      seen.comment += text.includes("</") ? 1 : 0;
      seen.scalarRoot += doc.root.node.t === "scalar" ? 1 : 0;
      seen.head += doc.head ? 1 : 0;
    }
    const share = (n: number) => n / SEEDS;
    expect(share(seen.annotated)).toBeGreaterThan(0.4);
    expect(share(seen.rootAnnotated)).toBeGreaterThan(0.1);
    expect(share(seen.manyAnnotations)).toBeGreaterThan(0.1);
    expect(share(seen.idAnnotation)).toBeGreaterThan(0.1);
    expect(share(seen.langAnnotation)).toBeGreaterThan(0.1);
    expect(share(seen.stringKey)).toBeGreaterThan(0.1);
    expect(share(seen.hashString)).toBeGreaterThan(0.1);
    expect(share(seen.tripleQuoteString)).toBeGreaterThan(0.1);
    expect(share(seen.radixInteger)).toBeGreaterThan(0.1);
    expect(share(seen.underscoreNumber)).toBeGreaterThan(0.1);
    expect(share(seen.special)).toBeGreaterThan(0.05);
    expect(share(seen.nestedContainer)).toBeGreaterThan(0.5);
    expect(share(seen.comment)).toBeGreaterThan(0.5);
    expect(share(seen.scalarRoot)).toBeLessThan(0.2);
    expect(share(seen.head)).toBeGreaterThan(0.2);
  });
});

describe("faults found by review, step 5", () => {
  it("keep an annotation and a stray separator after a key in source order", () => {
    for (const text of [
      "{ a <! tag x !> : 1 }",
      "{ a <! tag x !> : }",
      "{ a <! tag x !> <! tag y !> : : 1 }",
      "{ a : <! tag x !> 1 }",
      '{ "a": <! tag x !> 1, "b": 2 }',
    ]) {
      const { tree } = parse(text);
      expect(reconstruct(tree), text).toBe(text);
    }
  });

  it("match a wrong closing bracket in constant time, however deep", () => {
    const limits = { ...resolveLimits(), depth: 1_000_000 };
    const text = `{ a ${"[".repeat(100_000)} }`;
    const started = performance.now();
    const diagnostics: Diagnostic[] = [];
    parseDocument(text, limits, diagnostics);
    const elapsed = performance.now() - started;
    // The check once scanned the stack for every bracket, which is quadratic: seconds at this size.
    expect(elapsed).toBeLessThan(3000);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("do not match a closing bracket inside an annotation with a collection outside it", () => {
    // The `]` inside the annotation's value cannot close the sequence that holds the annotation.
    expect(codes("[ <! x { a ] !> 1 ]")).toContain("XFER0406");
    expect(parse("[ <! x { a ] !> 1 ]").tree.root?.kind).toBe("sequence");
  });

  it("report a broken annotation value once", () => {
    expect(codes("<! tag ~ !> 1")).toEqual(["XFER0103"]);
    expect(codes("<! tag <! tag a !> !> 1")).toEqual(["XFER0506", "XFER0501"]);
  });

  it("report content past the depth limit once, not once per token", () => {
    const deepObjects = `${"{a ".repeat(300)}1${" }".repeat(300)}`;
    expect(codes(deepObjects)).toEqual(["XFER0602"]);
    expect(codes("[".repeat(1000) + "]".repeat(1000))).toEqual(["XFER0602"]);
    // Unclosed: 256 real collections and the overflowing one are each unterminated, once.
    const unclosed = codes("[".repeat(300));
    expect(unclosed.filter((c) => c === "XFER0602")).toHaveLength(1);
    expect(unclosed.filter((c) => c === "XFER0405")).toHaveLength(257);
  });

  it("keep everything inside an overflowing container, so the tree stays lossless", () => {
    for (const text of [`${"[".repeat(300)}1 2 { a 3 }${"]".repeat(300)}`, "[".repeat(300)]) {
      expect(reconstruct(parse(text).tree), text.slice(0, 20)).toBe(text);
    }
  });

  it("skip a stray `!>` in an object, so the keys after it are still read", () => {
    // What is left when `<!` is forgotten: the next key must not become the stray token's value.
    expect(codes("{ a 1 !> b 2 }")).toEqual(["XFER0103"]);
    expect(codes("{ tag x !> a 1 }")).toEqual(["XFER0103"]);
    expect(reconstruct(parse("{ tag x !> a 1 }").tree)).toBe("{ tag x !> a 1 }");
  });

  it("do not also call an unclosed annotation dangling", () => {
    expect(codes("<! tag a")).toEqual(["XFER0506", "XFER0401"]);
    // Ordered by position: the collection opens before the annotation inside it.
    expect(codes("[ <! tag a")).toEqual(["XFER0405", "XFER0506"]);
    expect(codes("{ a 1 <! tag")).toEqual(["XFER0405", "XFER0506"]);
  });

  it("do not report a token the lexer reported again as an annotation's name", () => {
    expect(codes("<! ~x 1 !> 2")).toEqual(["XFER0103"]);
  });
});

describe("any input", () => {
  const pieces = [
    "{",
    "}",
    "[",
    "]",
    "<!",
    "!>",
    "</",
    "/>",
    "<",
    ">",
    '"',
    '""',
    '"""',
    "#",
    '#"',
    '"#',
    " ",
    "\n",
    "a",
    "b1",
    "true",
    "null",
    "-inf",
    "1",
    "-2",
    "0x1f",
    "1.5",
    "1__0",
    "2025-08-01",
    "09:30:00",
    "xfer",
    "tag",
    "id",
    "x",
    "é",
    "😀",
    " ",
    "~",
    ",",
    ":",
    "\u0000",
  ];

  it("never throws, always ends, and always reproduces the text", () => {
    const random = mulberry32(5150);
    for (let run = 0; run < 4000; run++) {
      const count = Math.floor(random() * 30);
      let text = "";
      for (let i = 0; i < count; i++) {
        text += pick(random, pieces) + (random() < 0.5 ? " " : "");
      }
      const result = parse(text);
      const where = JSON.stringify(text);
      expect(reconstruct(result.tree), where).toBe(result.tree.text);
      expect(result.ok, where).toBe(!result.diagnostics.some((d) => d.severity === "error"));
      expect(result.value !== undefined, where).toBe(result.ok);
      const offsets = result.diagnostics.map((d) => d.start.offset);
      expect(offsets, where).toEqual([...offsets].sort((a, b) => a - b));
      if (result.ok) {
        // A document that parsed has one value, and its canonical tagged form is well defined.
        expect(toTagged(result.value as NonNullable<typeof result.value>), where).toBeTypeOf(
          "object",
        );
      }
    }
  });

  it("never throws on arbitrary bytes", () => {
    const random = mulberry32(99);
    for (let run = 0; run < 1500; run++) {
      const bytes = new Uint8Array(Math.floor(random() * 40));
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(random() * 256);
      }
      const result = parse(bytes);
      expect(typeof result.ok).toBe("boolean");
    }
  });
});
