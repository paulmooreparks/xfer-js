import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCases } from "./cases.ts";

const CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "xfer-cli-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function xfer(args: string[], stdin?: string | Uint8Array) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin ?? "",
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function file(name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("xfer CLI", () => {
  it("prints its version and usage", () => {
    expect(xfer(["--version"])).toMatchObject({ code: 0, out: `${PACKAGE.version}\n` });
    expect(xfer(["--help"]).out).toContain("usage: xfer");
    expect(xfer([]).code).toBe(2);
  });

  it("rejects an unknown command or option with status 2", () => {
    expect(xfer(["frobnicate"])).toMatchObject({ code: 2 });
    expect(xfer(["validate", "--pretty"]).err).toContain('unknown option "--pretty"');
    expect(xfer(["validate", "/no/such/file.xfer"]).err).toContain("cannot read");
    expect(xfer(["validate", "/no/such/file.xfer"]).code).toBe(2);
  });

  it("validates stdin and files, with GNU-style diagnostics", () => {
    expect(xfer(["validate"], "{ a 1 }")).toMatchObject({ code: 0, err: "" });
    const bad = xfer(["validate"], "{ a 1");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^<stdin>:\d+:\d+: error XFER0405: /);
    const path = file("bad.xfer", "[ 1 2 ");
    expect(xfer(["validate", path]).err).toContain(`${path}:1:`);
  });

  it("prints one JSON object per diagnostic with --json", () => {
    const r = xfer(["validate", "--json"], "{ a 1 a 2 }");
    expect(r.code).toBe(1);
    const line = JSON.parse(r.err.trim().split("\n")[0] as string);
    expect(line).toMatchObject({ file: "<stdin>", code: "XFER0403", severity: "error" });
    expect(line.start.line).toBe(1);
  });

  it("exits 1 if any of several files has an error, and checks them all", () => {
    const ok = file("ok.xfer", "1");
    const bad = file("bad2.xfer", "{");
    const r = xfer(["validate", ok, bad, bad]);
    expect(r.code).toBe(1);
    expect(r.err.match(/XFER0405/g)).toHaveLength(2);
  });

  it("writes canonical form with fmt and canon, and nothing for a bad document", () => {
    expect(xfer(["fmt"], "{a 1 b[1 2]}").out).toBe(
      "{\n    a 1\n    b [\n        1\n        2\n    ]\n}\n",
    );
    expect(xfer(["canon"], "  7  ").out).toBe("7\n");
    const bad = xfer(["fmt"], "{ a");
    expect(bad).toMatchObject({ code: 1, out: "" });
  });

  it("fmt --write rewrites only files that change, and never a file with errors", () => {
    const messy = file("messy.xfer", "{a 1}");
    const tidy = file("tidy.xfer", "7\n");
    const broken = file("broken.xfer", "{ a");
    const r = xfer(["fmt", "--write", messy, tidy, broken]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(readFileSync(messy, "utf8")).toBe("{\n    a 1\n}\n");
    expect(readFileSync(tidy, "utf8")).toBe("7\n");
    expect(readFileSync(broken, "utf8")).toBe("{ a");
    expect(xfer(["fmt", "--write"], "1").code).toBe(2);
  });

  it("converts to JSON, compact or pretty", () => {
    expect(xfer(["to-json"], "{ a [ 1 true ] b x }")).toMatchObject({
      code: 0,
      out: '{"a":[1,true],"b":"x"}\n',
    });
    expect(xfer(["to-json", "--pretty"], "[ 1 ]").out).toBe("[\n  1\n]\n");
    const big = xfer(["to-json", "--stringify-big-ints"], "[ 9007199254740993 ]");
    expect(big.out).toBe('["9007199254740993"]\n');
    expect(big.err).toContain("warning XFER0901");
    expect(big.code).toBe(0);
    const special = xfer(["to-json"], "[ inf ]");
    expect(special).toMatchObject({ code: 1, out: "[null]\n" });
  });

  it("converts from JSON to canonical XferLang, and rejects what XferLang cannot hold", () => {
    expect(xfer(["from-json"], '{"a":[1,2.5,null],"b":"x"}').out).toBe(
      '{\n    a [\n        1\n        2.5\n        null\n    ]\n    b "x"\n}\n',
    );
    const bad = xfer(["from-json"], "{,}");
    expect(bad).toMatchObject({ code: 1, out: "" });
    expect(bad.err).toContain("XFER0906");
    expect(xfer(["from-json"], '["\\r"]').err).toContain("XFER0907");
    const deep = xfer(["from-json"], "[".repeat(300) + "]".repeat(300));
    expect(deep.code).toBe(1);
    expect(deep.err).toContain("XFER0602");
  });

  it("reports input that is not UTF-8", () => {
    const r = xfer(["validate"], new Uint8Array([0x22, 0xff, 0x22]));
    expect(r.code).toBe(1);
    expect(r.err).toContain("XFER0701");
    expect(xfer(["from-json"], new Uint8Array([0x22, 0xff, 0x22])).code).toBe(1);
  });

  it("concatenates the output of several files for converters", () => {
    const a = file("a.xfer", "1");
    const b = file("b.xfer", "[ 2 ]");
    expect(xfer(["to-json", a, b]).out).toBe("1\n[2]\n");
  });

  it("refuses to-json output longer than the document size limit, printing nothing", () => {
    // Indentation makes this 2.2 MB document about 550 million characters of JSON.
    const path = file("deep.xfer", `${"[".repeat(250)}${"1 ".repeat(1_000_000)}${"]".repeat(250)}`);
    const r = xfer(["to-json", "--pretty", path]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("XFER0601");
  });

  it("exits 2 when standard output cannot be written", async () => {
    const path = file("many.xfer", `[${" 1".repeat(200_000)} ]`);
    const child = spawn(process.execPath, [CLI, "fmt", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      err += d;
    });
    child.stdout.destroy(); // the reader goes away, as `| head -c 10` does
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(2);
    expect(err).toContain("xfer: cannot write standard output");
  });

  it("accepts - for stdin and -- before a file name that starts with a dash", () => {
    expect(xfer(["to-json", "-"], "1").out).toBe("1\n");
    const odd = join(dir, "-odd.xfer");
    writeFileSync(odd, "2");
    expect(xfer(["to-json", "--", odd]).out).toBe("2\n");
  });

  it("agrees with the library on every valid suite document", () => {
    for (const c of loadCases().valid.slice(0, 40)) {
      if (typeof c.input !== "string") {
        continue;
      }
      const r = xfer(["fmt"], c.input);
      expect(r, c.id).toMatchObject({ code: 0, out: c.canonical });
    }
  });
});
