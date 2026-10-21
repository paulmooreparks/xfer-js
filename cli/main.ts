import { readFileSync, readSync, writeFileSync } from "node:fs";
import { runCli } from "./run";

// The `xfer` command for Node: the CLI itself is cli/run.ts, which this file runs with the file
// system and the process's streams. A browser terminal runs the same function with its own.

function version(): string {
  const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(text) as { version: string }).version;
}

function readStdin(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(65536);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buffer, 0, buffer.length, null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EOF") {
        break;
      }
      if (code === "EAGAIN") {
        continue;
      }
      throw e;
    }
    if (n === 0) {
      break;
    }
    chunks.push(buffer.slice(0, n));
  }
  const all = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

// A failed write to standard output or standard error (a closed pipe, a full disk) is exit 2,
// whatever the documents said. The streams report it as an "error" event, which may come after
// runCli has returned, so the handlers set the exit code themselves and runCli's code yields to it.
let failedWrite = false;
process.stdout.on("error", () => {
  if (!failedWrite) {
    process.stderr.write("xfer: cannot write standard output\n");
  }
  failedWrite = true;
  process.exitCode = 2;
});
process.stderr.on("error", () => {
  failedWrite = true;
  process.exitCode = 2;
});

const code = await runCli(process.argv.slice(2), {
  readFile: async (name) => readFileSync(name),
  readStdin: async () => readStdin(),
  writeFile: async (name, text) => writeFileSync(name, text),
  stdout: (text) => {
    if (!process.stdout.destroyed) {
      process.stdout.write(text);
    }
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  version: version(),
});
if (!failedWrite) {
  process.exitCode = code;
}
