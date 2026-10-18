import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readTxtar } from "./txtar.ts";

const SUITE_TESTS = fileURLToPath(new URL("../suite/tests/", import.meta.url));

export interface ToJsonCase {
  readonly id: string;
  readonly xfer: string;
  /** The compact JSON text, without the final LF the archive adds. */
  readonly json: string;
  readonly codes: readonly string[];
  readonly stringifyBigInts: boolean;
}

export interface FromJsonCase {
  readonly id: string;
  readonly json: string;
  /** Absent when the conversion must produce no value. */
  readonly xfer: string | undefined;
  readonly codes: readonly string[];
}

function codesOf(id: string, diag: string | undefined): string[] {
  if (diag === undefined) {
    return [];
  }
  return diag
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const m = /^(XFER\d{4}) \*$/.exec(line);
      if (!m) {
        throw new Error(`suite: ${id}: bad diagnostic line "${line}"`);
      }
      return m[1] as string;
    });
}

function stems(file: string, suffixes: readonly string[]) {
  const entries = readTxtar(readFileSync(`${SUITE_TESTS}${file}`, "utf8"));
  const out = new Map<string, Map<string, string>>();
  for (const [name, body] of entries) {
    const suffix = suffixes.find((s) => name.endsWith(s));
    if (suffix === undefined) {
      throw new Error(`suite: ${file}: unexpected entry ${name}`);
    }
    const stem = name.slice(0, -suffix.length);
    let files = out.get(stem);
    if (files === undefined) {
      files = new Map();
      out.set(stem, files);
    }
    files.set(suffix, body);
  }
  return out;
}

export function loadToJsonCases(): ToJsonCase[] {
  const cases: ToJsonCase[] = [];
  for (const [stem, files] of stems("to-json.txtar", [".xfer", ".json", ".diag", ".options"])) {
    const id = `to-json/${stem}`;
    const xfer = files.get(".xfer");
    const json = files.get(".json");
    if (xfer === undefined || json === undefined || !json.endsWith("\n")) {
      throw new Error(`suite: ${id} needs .xfer and a .json that ends with a newline`);
    }
    const options = (files.get(".options") ?? "").split("\n").filter((l) => l.trim() !== "");
    for (const o of options) {
      if (o !== "stringify-big-ints") {
        throw new Error(`suite: ${id}: unknown option ${o}`);
      }
    }
    cases.push({
      id,
      xfer,
      json: json.slice(0, -1),
      codes: codesOf(id, files.get(".diag")),
      stringifyBigInts: options.includes("stringify-big-ints"),
    });
  }
  if (cases.length === 0) {
    throw new Error("suite: no to-json cases");
  }
  return cases;
}

export function loadFromJsonCases(): FromJsonCase[] {
  const cases: FromJsonCase[] = [];
  for (const [stem, files] of stems("from-json.txtar", [".json", ".xfer", ".diag"])) {
    const id = `from-json/${stem}`;
    const json = files.get(".json");
    if (json === undefined) {
      throw new Error(`suite: ${id} has no .json`);
    }
    cases.push({
      id,
      json,
      xfer: files.get(".xfer"),
      codes: codesOf(id, files.get(".diag")),
    });
  }
  if (cases.length === 0) {
    throw new Error("suite: no from-json cases");
  }
  return cases;
}
