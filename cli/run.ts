import {
  canonical,
  type Diagnostic,
  fromJson,
  parse,
  toJson,
  XferError,
  type XferValue,
} from "../src/index";

/**
 * What the CLI needs from the place it runs: its files, its streams and its version. The Node
 * command (`cli/main.ts`) gives it the file system and the process's streams; a browser terminal
 * gives it its own files and output, so both run this code and print the same bytes.
 */
export interface CliHost {
  /** A file's bytes, or its text where the host keeps text. Rejects when it cannot be read. */
  readFile(name: string): Promise<Uint8Array | string>;
  /** Standard input, read to its end. */
  readStdin(): Promise<Uint8Array | string>;
  /** Replaces a file's contents with UTF-8 text (for `fmt --write`). Rejects when it cannot. */
  writeFile(name: string, text: string): Promise<void>;
  /** Writes to standard output. */
  stdout(text: string): void;
  /** Writes to standard error. */
  stderr(text: string): void;
  /** The version `--version` prints. */
  readonly version: string;
}

export const USAGE = `usage: xfer <command> [options] [FILE...]

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

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const utf8 = new TextEncoder();

function report(
  host: CliHost,
  file: string,
  diagnostics: readonly Diagnostic[],
  json: boolean,
): void {
  for (const d of diagnostics) {
    if (json) {
      host.stderr(`${JSON.stringify({ file, ...d })}\n`);
    } else if (d.severity !== "info") {
      host.stderr(
        `${file}:${d.start.line}:${d.start.column}: ${d.severity} ${d.code}: ${d.message}\n`,
      );
    }
  }
}

/** The text of a JSON input, decoded as TextDecoder decodes it: strictly, a leading byte order mark dropped. */
function jsonText(input: Uint8Array | string): string | undefined {
  if (typeof input === "string") {
    return input.startsWith(BYTE_ORDER_MARK) ? input.slice(1) : input;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return undefined;
  }
}

/** Processes one input, appending its output to `out`, and returns whether it was free of errors. */
function processOne(
  host: CliHost,
  command: string,
  file: string,
  input: Uint8Array | string,
  options: Options,
  out: string[],
): { ok: boolean; output?: string } {
  switch (command) {
    case "validate": {
      const result = parse(input);
      report(host, file, result.diagnostics, options.json);
      return { ok: result.ok };
    }
    case "fmt":
    case "canon": {
      const result = parse(input);
      report(host, file, result.diagnostics, options.json);
      if (!result.ok) {
        return { ok: false };
      }
      try {
        const text = canonical(result);
        out.push(text);
        return { ok: true, output: text };
      } catch (e) {
        if (e instanceof XferError) {
          host.stderr(`${file}: error: ${e.message}\n`);
          return { ok: false };
        }
        throw e;
      }
    }
    case "to-json": {
      const result = parse(input);
      report(host, file, result.diagnostics, options.json);
      if (!result.ok) {
        return { ok: false };
      }
      const converted = toJson(result.value as XferValue, {
        stringifyBigInts: options.stringifyBigInts,
        ...(options.pretty ? { indent: 2 } : {}),
      });
      report(host, file, converted.diagnostics, options.json);
      if (converted.text === undefined) {
        return { ok: false }; // refused as longer than the document size limit (XFER0601)
      }
      out.push(`${converted.text}\n`);
      return { ok: !converted.diagnostics.some((d) => d.severity === "error") };
    }
    default: {
      const text = jsonText(input);
      if (text === undefined) {
        host.stderr(`${file}: error: input is not valid UTF-8\n`);
        return { ok: false };
      }
      const converted = fromJson(text);
      report(host, file, converted.diagnostics, options.json);
      if (converted.value === undefined) {
        return { ok: false };
      }
      try {
        out.push(canonical(converted.value));
      } catch (e) {
        if (e instanceof XferError || e instanceof TypeError) {
          host.stderr(`${file}: error: ${e.message}\n`);
          return { ok: false };
        }
        throw e;
      }
      return { ok: true };
    }
  }
}

function sameBytes(input: Uint8Array | string, text: string): boolean {
  if (typeof input === "string") {
    return input === text;
  }
  const encoded = utf8.encode(text);
  return input.length === encoded.length && input.every((b, i) => b === encoded[i]);
}

async function main(args: readonly string[], host: CliHost): Promise<number> {
  if (args.length === 0) {
    host.stderr(USAGE);
    return 2;
  }
  const first = args[0] as string;
  if (first === "--help" || first === "-h") {
    host.stdout(USAGE);
    return 0;
  }
  if (first === "--version") {
    host.stdout(`${host.version}\n`);
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
  const inputs: { file: string; input: Uint8Array | string }[] = [];
  for (const file of files) {
    try {
      inputs.push({
        file,
        input: file === "-" ? await host.readStdin() : await host.readFile(file),
      });
    } catch (e) {
      throw new UsageError(`cannot read ${file}: ${(e as Error).message}`);
    }
  }

  let allOk = true;
  for (const { file, input } of inputs) {
    // Each file's output is written as soon as it is made, never joined with the others, so no
    // string has to hold the output of every file.
    const out: string[] = [];
    const result = processOne(host, first, file === "-" ? "<stdin>" : file, input, options, out);
    allOk &&= result.ok;
    if (!options.write) {
      for (const text of out) {
        host.stdout(text);
      }
    } else if (result.ok && result.output !== undefined && !sameBytes(input, result.output)) {
      try {
        await host.writeFile(file, result.output);
      } catch (e) {
        throw new UsageError(`cannot write ${file}: ${(e as Error).message}`);
      }
    }
  }
  return allOk ? 0 : 1;
}

/**
 * Runs the `xfer` command line with these arguments (without the command's own name) and returns
 * its exit status: 0 success, 1 a document had an error, 2 a usage error or an unreadable file.
 * Everything it prints goes through the host.
 */
export async function runCli(args: readonly string[], host: CliHost): Promise<number> {
  try {
    return await main(args, host);
  } catch (e) {
    if (e instanceof UsageError) {
      host.stderr(`xfer: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
