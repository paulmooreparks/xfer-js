// A conformance runner with no test framework and no build step beyond `npm run build`, so that
// the built package can be checked on runtimes the development tools do not support: Node 18 and
// 20, Deno and Bun. It reads the suite with node:fs, which all of them provide; the checks
// themselves are in smoke/checks.mjs, which smoke/browser.mjs runs in browsers.
//
//   node smoke/run.mjs      deno run -A smoke/run.mjs      bun smoke/run.mjs

import { readdirSync, readFileSync } from "node:fs";
import { report, runChecks } from "./checks.mjs";

const root = new URL("../", import.meta.url);
const lib = await import(new URL("dist/index.js", root).href);

const result = await runChecks({
  lib,
  readText: async (path) => readFileSync(new URL(path, root), "utf8"),
  readBytes: async (path) => new Uint8Array(readFileSync(new URL(path, root))),
  bytesNames: readdirSync(new URL("suite/tests/bytes/", root)),
});

const runtime =
  typeof Deno !== "undefined"
    ? `Deno ${Deno.version.deno}`
    : typeof Bun !== "undefined"
      ? `Bun ${Bun.version}`
      : `Node ${process.versions.node}`;
if (!report(runtime, result)) {
  process.exit(1);
}
