import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readTxtar } from "./txtar.ts";

export interface ExpectedDiagnostic {
  readonly code: string;
  /** Undefined when the case requires the code at any position (`CODE *`). */
  readonly at: { readonly line: number; readonly column: number } | undefined;
}

export interface ValidCase {
  readonly id: string;
  readonly input: string | Uint8Array;
  readonly canonical: string;
  readonly value: unknown;
}

export interface InvalidCase {
  readonly id: string;
  readonly input: string | Uint8Array;
  readonly diagnostics: readonly ExpectedDiagnostic[];
}

const SUITE_TESTS = fileURLToPath(new URL("../suite/tests/", import.meta.url));

// Longest first, so that ".canonical.xfer" is not mistaken for ".xfer".
const SUFFIXES = [".canonical.xfer", ".value.json", ".diag", ".xfer"] as const;
type Suffix = (typeof SUFFIXES)[number];

function splitName(name: string): { stem: string; suffix: Suffix } | undefined {
  for (const suffix of SUFFIXES) {
    if (name.endsWith(suffix)) {
      return { stem: name.slice(0, -suffix.length), suffix };
    }
  }
  return undefined;
}

interface Files {
  readonly text: Map<Suffix, string>;
  readonly bytes: Map<Suffix, Uint8Array>;
}

function group(source: string, entries: Iterable<[string, string | Uint8Array]>) {
  const stems = new Map<string, Files>();
  for (const [name, content] of entries) {
    const parts = splitName(name);
    if (parts === undefined) {
      continue; // README and the like
    }
    let files = stems.get(parts.stem);
    if (files === undefined) {
      files = { text: new Map(), bytes: new Map() };
      stems.set(parts.stem, files);
    }
    if (typeof content === "string") {
      files.text.set(parts.suffix, content);
    } else {
      files.bytes.set(parts.suffix, content);
    }
  }
  if (stems.size === 0) {
    throw new Error(`suite: no cases found in ${source}`);
  }
  return stems;
}

function parseDiag(source: string, text: string): ExpectedDiagnostic[] {
  const out: ExpectedDiagnostic[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const m = /^(XFER\d{4}) (\*|(\d+):(\d+))$/.exec(line);
    if (!m) {
      throw new Error(`suite: ${source}: bad diagnostic line "${line}"`);
    }
    const at = m[2] === "*" ? undefined : { line: Number(m[3]), column: Number(m[4]) };
    out.push({ code: m[1] as string, at });
  }
  if (out.length === 0) {
    throw new Error(`suite: ${source}: a .diag file lists no diagnostics`);
  }
  return out;
}

export interface Cases {
  readonly valid: ValidCase[];
  readonly invalid: InvalidCase[];
}

function read(group_: string, stems: Map<string, Files>, into: Cases, seen: Set<string>): void {
  for (const [stem, files] of stems) {
    const id = `${group_}/${stem}`;
    if (seen.has(id)) {
      throw new Error(`suite: duplicate case ${id}`);
    }
    seen.add(id);
    const textOf = (s: Suffix): string | undefined =>
      files.text.get(s) ??
      (files.bytes.has(s) ? new TextDecoder().decode(files.bytes.get(s)) : undefined);
    const input: string | Uint8Array | undefined =
      files.bytes.get(".xfer") ?? files.text.get(".xfer");
    if (input === undefined) {
      throw new Error(`suite: ${id} has no .xfer input`);
    }
    const diag = textOf(".diag");
    const canonical = textOf(".canonical.xfer");
    const value = textOf(".value.json");
    if (diag !== undefined) {
      if (canonical !== undefined || value !== undefined) {
        throw new Error(`suite: ${id} has both .diag and valid-case files`);
      }
      into.invalid.push({ id, input, diagnostics: parseDiag(id, diag) });
    } else {
      if (canonical === undefined || value === undefined) {
        throw new Error(`suite: ${id} needs .canonical.xfer and .value.json (or a .diag)`);
      }
      into.valid.push({ id, input, canonical, value: JSON.parse(value) });
    }
  }
}

function readArchive(file: string): Map<string, Files> {
  const text = readFileSync(`${SUITE_TESTS}${file}`, "utf8");
  return group(file, readTxtar(text));
}

function readBytes(): Map<string, Files> {
  const dir = `${SUITE_TESTS}bytes/`;
  const entries: [string, Uint8Array][] = readdirSync(dir).map((name) => [
    name,
    new Uint8Array(readFileSync(`${dir}${name}`)),
  ]);
  return group("bytes/", entries);
}

/** Loads every case in the pinned suite. Throws on a malformed case, so a suite error is loud. */
export function loadCases(): Cases {
  const cases: Cases = { valid: [], invalid: [] };
  const seen = new Set<string>();
  read("valid", readArchive("valid.txtar"), cases, seen);
  read("invalid", readArchive("invalid.txtar"), cases, seen);
  read("bytes", readBytes(), cases, seen);
  return cases;
}
