// Runs the smoke checks (smoke/checks.mjs) against the built package in real browsers, which the
// roadmap's first milestone asks for and no other test does. The repository is served on a
// loopback port, each browser loads the package and the checks as ES modules, reads the suite over
// HTTP, and hands the result back here.
//
//   npm run build && node smoke/browser.mjs [chromium] [firefox] [webkit]
//
// With no names it runs all three. The browsers are Playwright's (`npx playwright install`).

import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { report } from "./checks.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html" };

// Serves files under the repository, and nothing outside it.
const server = createServer((request, response) => {
  const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1);
  if (requested === "") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>xferlang smoke</title>");
    return;
  }
  const path = normalize(requested);
  if (path.split(sep).includes("..")) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(root + path);
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const engines = { chromium, firefox, webkit };
const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(engines);
const bytesNames = readdirSync(new URL("../suite/tests/bytes/", import.meta.url));
let ok = true;
for (const name of names) {
  const engine = engines[name];
  if (engine === undefined) {
    console.error(`unknown browser "${name}"`);
    ok = false;
    continue;
  }
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/`);
    const result = await page.evaluate(async (bytesNames) => {
      const lib = await import("/dist/index.js");
      const { runChecks } = await import("/smoke/checks.mjs");
      const read = async (path) => {
        const response = await fetch(`/${path}`);
        if (!response.ok) {
          throw new Error(`${path}: ${response.status}`);
        }
        return response;
      };
      return runChecks({
        lib,
        readText: async (path) => (await read(path)).text(),
        readBytes: async (path) => new Uint8Array(await (await read(path)).arrayBuffer()),
        bytesNames,
      });
    }, bytesNames);
    ok = report(`${name} ${browser.version()}`, result) && ok;
  } finally {
    await browser.close();
  }
}
server.close();
process.exit(ok ? 0 : 1);
