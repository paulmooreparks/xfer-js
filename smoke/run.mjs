// A conformance runner with no test framework and no build step beyond `npm run build`, so that
// the built package can be checked on runtimes the development tools do not support: Node 18 and
// 20, Deno and Bun. It uses only node:fs, which all of them provide.
//
//   node smoke/run.mjs      deno run -A smoke/run.mjs      bun smoke/run.mjs
//
// It checks what the Vitest suite checks about the public API (canonical form, diagnostics, the
// JSON mapping) but not the value model or the tree, which need the TypeScript helpers.

import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const lib = await import(new URL("dist/index.js", root).href);
const { parse, canonical, toJson, fromJson } = lib;

function txtar(name) {
  const entries = new Map();
  let current;
  let body = [];
  const flush = () => {
    if (current !== undefined) {
      entries.set(current, body.join(""));
    }
  };
  const lines = readFileSync(new URL(`suite/tests/${name}`, root), "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = /^-- (.+?) --$/.exec(line);
    if (m) {
      flush();
      current = m[1];
      body = [];
    } else if (current !== undefined) {
      body.push(i === lines.length - 1 ? line : `${line}\n`);
    }
  });
  flush();
  return entries;
}

function group(entries, suffixes) {
  const stems = new Map();
  for (const [name, text] of entries) {
    const suffix = suffixes.find((s) => name.endsWith(s));
    if (suffix === undefined) {
      continue;
    }
    const stem = name.slice(0, -suffix.length);
    if (!stems.has(stem)) {
      stems.set(stem, new Map());
    }
    stems.get(stem).set(suffix, text);
  }
  return stems;
}

let failures = 0;
let count = 0;
function check(id, condition, detail) {
  count++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${id}: ${detail}`);
  }
}

const codesOf = (diag) =>
  (diag ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[0]);

// valid.txtar and invalid.txtar, plus the byte-exact cases.
const archives = [
  ["valid", group(txtar("valid.txtar"), [".canonical.xfer", ".value.json", ".diag", ".xfer"])],
  ["invalid", group(txtar("invalid.txtar"), [".canonical.xfer", ".value.json", ".diag", ".xfer"])],
];
const bytesDir = new URL("suite/tests/bytes/", root);
const bytes = new Map();
for (const name of readdirSync(bytesDir)) {
  for (const suffix of [".canonical.xfer", ".value.json", ".diag", ".xfer"]) {
    if (name.endsWith(suffix)) {
      const stem = name.slice(0, -suffix.length);
      if (!bytes.has(stem)) {
        bytes.set(stem, new Map());
      }
      bytes.get(stem).set(suffix, new Uint8Array(readFileSync(new URL(name, bytesDir))));
      break; // ".canonical.xfer" also ends in ".xfer"; the first (longest) suffix wins
    }
  }
  // README and the like are ignored.
}
const decode = (b) => new TextDecoder().decode(b);

function run(id, input, canonicalText, diagText) {
  const result = parse(input);
  if (diagText !== undefined) {
    check(id, !result.ok, "must be rejected");
    const have = new Set(result.diagnostics.map((d) => d.code));
    for (const want of codesOf(diagText)) {
      check(id, have.has(want), `missing ${want}`);
    }
  } else {
    check(id, result.ok, `unexpected ${result.diagnostics.map((d) => d.code).join(",")}`);
    if (result.ok) {
      const text = canonical(result);
      check(id, text === canonicalText, "canonical form differs");
      check(id, canonical(parse(text)) === text, "canonical form is not idempotent");
    }
  }
}

for (const [group_, stems] of archives) {
  for (const [stem, files] of stems) {
    const input = files.get(".xfer");
    if (input === undefined) {
      continue;
    }
    run(`${group_}/${stem}`, input, files.get(".canonical.xfer"), files.get(".diag"));
  }
}
for (const [stem, files] of bytes) {
  const input = files.get(".xfer");
  if (input === undefined) {
    continue;
  }
  const canon = files.get(".canonical.xfer");
  const diag = files.get(".diag");
  run(`bytes/${stem}`, input, canon && decode(canon), diag && decode(diag));
}

// The JSON mapping.
const toCases = group(txtar("to-json.txtar"), [".xfer", ".json", ".diag", ".options"]);
for (const [stem, files] of toCases) {
  const id = `to-json/${stem}`;
  const result = parse(files.get(".xfer"));
  check(id, result.ok, "input must parse");
  const options = {
    stringifyBigInts: (files.get(".options") ?? "").includes("stringify-big-ints"),
  };
  const out = toJson(result.value, options);
  check(id, `${out.text}\n` === files.get(".json"), `got ${out.text}`);
  const have = new Set(out.diagnostics.map((d) => d.code));
  for (const want of codesOf(files.get(".diag"))) {
    check(id, have.has(want), `missing ${want}`);
  }
}
const fromCases = group(txtar("from-json.txtar"), [".json", ".xfer", ".diag"]);
for (const [stem, files] of fromCases) {
  const id = `from-json/${stem}`;
  const out = fromJson(files.get(".json"));
  const have = new Set(out.diagnostics.map((d) => d.code));
  for (const want of codesOf(files.get(".diag"))) {
    check(id, have.has(want), `missing ${want}`);
  }
  const want = files.get(".xfer");
  if (want === undefined) {
    check(id, out.value === undefined, "must give no value");
  } else {
    check(id, out.value !== undefined && canonical(out.value) === want, "canonical form differs");
  }
}

const runtime =
  typeof Deno !== "undefined"
    ? `Deno ${Deno.version.deno}`
    : typeof Bun !== "undefined"
      ? `Bun ${Bun.version}`
      : `Node ${process.versions.node}`;
console.log(`${runtime}: ${count - failures} of ${count} checks passed`);
if (failures > 0 || count < 400) {
  console.error(failures > 0 ? `${failures} failed` : `only ${count} checks ran`);
  process.exit(1);
}
