// The checks of the smoke runners, with no file system, so that the same checks run under Node,
// Deno and Bun (smoke/run.mjs, which reads the suite from disk) and in browsers
// (smoke/browser.mjs, which serves it over HTTP). The caller supplies the built package and two
// readers, each returning a promise:
//
//   readText(path)   the suite file at a path relative to the repository, as a string
//   readBytes(path)  the same, as a Uint8Array
//
// and the names of the files in suite/tests/bytes/, which no browser can list. It checks what the
// Vitest suite checks about the public API (canonical form, diagnostics, the JSON mapping) but not
// the value model or the tree, which need the TypeScript helpers.

export async function runChecks({ lib, readText, readBytes, bytesNames }) {
  const { parse, canonical, toJson, fromJson } = lib;
  const failures = [];
  let count = 0;
  const check = (id, condition, detail) => {
    count++;
    if (!condition) {
      failures.push(`${id}: ${detail}`);
    }
  };

  async function txtar(name) {
    const entries = new Map();
    let current;
    let body = [];
    const flush = () => {
      if (current !== undefined) {
        entries.set(current, body.join(""));
      }
    };
    const lines = (await readText(`suite/tests/${name}`)).split("\n");
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

  const codesOf = (diag) =>
    (diag ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")[0]);

  // valid.txtar and invalid.txtar, plus the byte-exact cases.
  const suffixes = [".canonical.xfer", ".value.json", ".diag", ".xfer"];
  const archives = [
    ["valid", group(await txtar("valid.txtar"), suffixes)],
    ["invalid", group(await txtar("invalid.txtar"), suffixes)],
  ];
  const bytes = new Map();
  for (const name of bytesNames) {
    for (const suffix of suffixes) {
      if (name.endsWith(suffix)) {
        const stem = name.slice(0, -suffix.length);
        if (!bytes.has(stem)) {
          bytes.set(stem, new Map());
        }
        bytes.get(stem).set(suffix, await readBytes(`suite/tests/bytes/${name}`));
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
  const toCases = group(await txtar("to-json.txtar"), [".xfer", ".json", ".diag", ".options"]);
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
  const fromCases = group(await txtar("from-json.txtar"), [".json", ".xfer", ".diag"]);
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

  return { count, failures };
}

/** Prints the result and says whether it is a pass: no failures, and enough checks that an empty suite cannot pass. */
export function report(runtime, { count, failures }) {
  for (const f of failures) {
    console.error(`FAIL ${f}`);
  }
  console.log(`${runtime}: ${count - failures.length} of ${count} checks passed`);
  if (failures.length > 0 || count < 400) {
    console.error(failures.length > 0 ? `${failures.length} failed` : `only ${count} checks ran`);
    return false;
  }
  return true;
}
