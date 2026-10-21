# xferlang

xferlang is the JavaScript and TypeScript implementation of XferLang, a data format with the data model of JSON, typed values, no escape sequences anywhere in its grammar, and no meaning in line breaks or indentation. Any text can be embedded in an XferLang string exactly as it is, at any depth, including another XferLang document.

The package has no runtime dependencies and runs unchanged in Node, browsers, Deno and Bun. It contains a parser that reports every fault as a diagnostic with a stable code and never throws on bad input, a lossless syntax tree, a canonical writer, a conversion to and from JSON, and the `xfer` command line tool.

The specification and its conformance suite live in the [xferlang](https://github.com/paulmooreparks/xferlang) repository, which this repository includes as the `suite` submodule. This package passes every case in the suite.

The package is not published yet; the first release, `0.1.0-next.0`, is on the `next` tag.

## A document

```
<! xfer 1 !>
{
    title """She said "hello" and left"""
    count 42
    ratio 1.50
    released 2025-08-01
    mode dark
    tags [ alpha beta ]
    script """
        const s = "no escaping needed";
    """
}
```

Strings are written between runs of quotation marks, and a string that contains quotation marks is simply written with a longer run, so nothing inside it is ever escaped. Bare words are symbols, `true`, `false` and `null` are keywords, integers keep their exact value at any size, and dates and times are values of their own type.

## Using it

```ts
import { parse, parseValue, canonical, toJson, fromJson, toPlain } from "xferlang";

// Parsing never throws. Every fault is a diagnostic.
const result = parse('{ name "Ada" langs [ en fr ] }');
if (!result.ok) {
  for (const d of result.diagnostics) {
    console.error(`${d.start.line}:${d.start.column} ${d.code} ${d.message}`);
  }
}

// Or take the value and let an error throw an XferError that carries the diagnostics.
const value = parseValue('{ n 12345678901234567890 }');

// The canonical form: the one way to write a document, byte for byte.
console.log(canonical(parse("{a 1 b[2 3]}")));

// Plain JavaScript data (integers beyond 2^53 become bigint).
console.log(toPlain(value));

// JSON in both directions. Each reports what it could not map exactly.
const { text, diagnostics } = toJson(value, { stringifyBigInts: true });
const back = fromJson('{"a":[1,2.5,null]}');
```

Parser limits (nesting depth, document size, token length, delimiter run length, element count) default to the specification's minimums and can be raised or lowered with `{ limits: { depth: 64 } }`.

`asNumber`, `asDecimal` and `asTemporal` turn individual values into JavaScript numbers, exact decimals and `Temporal` objects, and say when a conversion is not exact. The lossless tree is available as `result.tree` for tools that need every byte of the source, such as formatters and editors.

The full API is generated with `npm run docs`.

## Command line

```sh
xfer validate file.xfer          # diagnostics as FILE:LINE:COL: error XFER0405: message
xfer fmt --write file.xfer       # rewrite in canonical form
xfer to-json --pretty file.xfer
xfer from-json < data.json
```

With no file, or with `-`, input is read from standard input. The exit status is 0 for success, 1 if any document had an error, and 2 for a usage error or an unreadable file. `--json` prints diagnostics as one JSON object per line.

The same command line runs anywhere as a function, with the files and streams supplied by the caller, which is how a terminal in a web page runs the real `xfer`:

```ts
import { runCli } from "xferlang/cli";

const status = await runCli(["fmt", "a.xfer"], {
  readFile: async (name) => myFiles.get(name),   // bytes or text
  readStdin: async () => "",
  writeFile: async (name, text) => myFiles.set(name, text),
  stdout: (text) => print(text),
  stderr: (text) => printError(text),
  version: "my-terminal",
});
```

## Development

Clone with submodules, then install and check:

```sh
git clone --recurse-submodules https://github.com/paulmooreparks/xfer-js
cd xfer-js
npm ci
npm run check        # lint, typecheck, tests
npm run build
npm run test:cli     # needs the build
npm run smoke        # the built package against the suite, with no test framework
npm run smoke:browser   # the same in Chromium, Firefox and WebKit (npx playwright install first)
```

Building and testing need Node 22 or later, because the build and test tools require it. The built package is also checked on Node 18 and 20, Deno and Bun, and in Chromium, Firefox and WebKit, in CI. [DESIGN.md](DESIGN.md) describes how the package is built and records the decisions made along the way.

## Licence

MIT.
