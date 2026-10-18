import { readFileSync, readSync, writeFileSync } from "node:fs";
import {
  canonical,
  type Diagnostic,
  fromJson,
  parse,
  toJson,
  XferError,
  type XferValue,
} from "../src/index";

const USAGE = `usage: xfer <command> [options] [FILE...]

commands:
  validate [--json]                      check documents; print diagnostics
  fmt [--write]                          canonical form to stdout, or in place with --write
  canon                                  same as fmt without --write
  to-json [--pretty] [--stringify-big-ints]
                                         convert XferLang to JSON
  from-json                              convert JSON to XferLang (canonical form)

options:
  --json       print diagnostics as one JSON object per line
  --version    print the version
  --help       print this text

With no FILE, or with -, input is read from standard input.
Exit status: 0 success, 1 a document had an error, 2 usage error or unreadable file.
`;

class UsageError extends Error {}

interface Options {
  json: boolean;
  write: boolean;
  pretty: boolean;
  stringifyBigInts: boolean;
}

const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  validate: ["--json"],
  fmt: ["--write", "--json"],
  canon: ["--json"],
  "to-json": ["--pretty", "--stringify-big-ints", "--json"],
  "from-json": ["--json"],
};

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

function report(file: string, diagnostics: readonly Diagnostic[], json: boolean): void {
  for (const d of diagnostics) {
    if (json) {
      process.stderr.write(`${JSON.stringify({ file, ...d })}\n`);
    } else if (d.severity !== "info") {
      process.stderr.write(
        `${file}:${d.start.line}:${d.start.column}: ${d.severity} ${d.code}: ${d.message}\n`,
      );
    }
  }
}

/** Processes one input and returns whether it was free of errors. */
function process1(
  command: string,
  file: string,
  bytes: Uint8Array,
  options: Options,
  out: string[],
): { ok: boolean; output?: string } {
  switch (command) {
    case "validate": {
      const result = parse(bytes);
      report(file, result.diagnostics, options.json);
      return { ok: result.ok };
    }
    case "fmt":
    case "canon": {
      const result = parse(bytes);
      report(file, result.diagnostics, options.json);
      if (!result.ok) {
        return { ok: false };
      }
      try {
        const text = canonical(result);
        out.push(text);
        return { ok: true, output: text };
      } catch (e) {
        if (e instanceof XferError) {
          process.stderr.write(`${file}: error: ${e.message}\n`);
          return { ok: false };
        }
        throw e;
      }
    }
    case "to-json": {
      const result = parse(bytes);
      report(file, result.diagnostics, options.json);
      if (!result.ok) {
        return { ok: false };
      }
      const converted = toJson(result.value as XferValue, {
        stringifyBigInts: options.stringifyBigInts,
        ...(options.pretty ? { indent: 2 } : {}),
      });
      report(file, converted.diagnostics, options.json);
      out.push(`${converted.text}\n`);
      return { ok: !converted.diagnostics.some((d) => d.severity === "error") };
    }
    default: {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        process.stderr.write(`${file}: error: input is not valid UTF-8\n`);
        return { ok: false };
      }
      const converted = fromJson(text);
      report(file, converted.diagnostics, options.json);
      if (converted.value === undefined) {
        return { ok: false };
      }
      try {
        out.push(canonical(converted.value));
      } catch (e) {
        if (e instanceof XferError || e instanceof TypeError) {
          process.stderr.write(`${file}: error: ${e.message}\n`);
          return { ok: false };
        }
        throw e;
      }
      return { ok: true };
    }
  }
}

function main(args: readonly string[]): number {
  if (args.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const first = args[0] as string;
  if (first === "--help" || first === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (first === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  const allowed = COMMAND_OPTIONS[first];
  if (allowed === undefined) {
    throw new UsageError(`unknown command "${first}"`);
  }

  const options: Options = { json: false, write: false, pretty: false, stringifyBigInts: false };
  const files: string[] = [];
  let optionsDone = false;
  for (const arg of args.slice(1)) {
    if (!optionsDone && arg === "--") {
      optionsDone = true;
    } else if (!optionsDone && arg.startsWith("-") && arg !== "-") {
      if (!allowed.includes(arg)) {
        throw new UsageError(`${first}: unknown option "${arg}"`);
      }
      switch (arg) {
        case "--json":
          options.json = true;
          break;
        case "--write":
          options.write = true;
          break;
        case "--pretty":
          options.pretty = true;
          break;
        case "--stringify-big-ints":
          options.stringifyBigInts = true;
          break;
      }
    } else {
      files.push(arg);
    }
  }
  if (options.write && (files.length === 0 || files.includes("-"))) {
    throw new UsageError("fmt --write needs file names; it cannot write to standard input");
  }
  if (files.length === 0) {
    files.push("-");
  }

  // Read everything first, so an unreadable file is a usage-level failure before any output.
  const inputs: { file: string; bytes: Uint8Array }[] = [];
  for (const file of files) {
    try {
      inputs.push({ file, bytes: file === "-" ? readStdin() : readFileSync(file) });
    } catch (e) {
      throw new UsageError(`cannot read ${file}: ${(e as Error).message}`);
    }
  }

  let allOk = true;
  const out: string[] = [];
  for (const { file, bytes } of inputs) {
    const before = out.length;
    const result = process1(first, file === "-" ? "<stdin>" : file, bytes, options, out);
    allOk &&= result.ok;
    if (options.write && result.ok && result.output !== undefined) {
      out.length = before; // --write never prints
      const same =
        bytes.length === Buffer.byteLength(result.output) &&
        Buffer.compare(Buffer.from(bytes), Buffer.from(result.output)) === 0;
      if (!same) {
        try {
          writeFileSync(file, result.output);
        } catch (e) {
          throw new UsageError(`cannot write ${file}: ${(e as Error).message}`);
        }
      }
    }
  }
  if (out.length > 0) {
    process.stdout.write(out.join(""));
  }
  return allOk ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`xfer: ${e.message}\n`);
    process.exitCode = 2;
  } else {
    throw e;
  }
}
