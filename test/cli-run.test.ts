import { describe, expect, it } from "vitest";
import { type CliHost, runCli, USAGE } from "../cli/run";

// runCli as a browser terminal runs it: files held as text in memory, no file system, no process.

function host(files: Record<string, string>, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const h: CliHost = {
    readFile: async (name) => {
      const text = files[name];
      if (text === undefined) {
        throw new Error("no such file");
      }
      return text;
    },
    readStdin: async () => stdin,
    writeFile: async (name, text) => {
      files[name] = text;
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    version: "9.9.9",
  };
  return { h, files, out: () => out.join(""), err: () => err.join("") };
}

describe("runCli", () => {
  it("validates, formats and converts text held in memory", async () => {
    const t = host({ "a.xfer": '{b [1 2] a "x"}', "bad.xfer": "{ a 1" });
    expect(await runCli(["validate", "a.xfer"], t.h)).toBe(0);
    expect(await runCli(["fmt", "a.xfer"], t.h)).toBe(0);
    expect(t.out()).toBe('{\n    b [\n        1\n        2\n    ]\n    a "x"\n}\n');
    expect(await runCli(["validate", "bad.xfer"], t.h)).toBe(1);
    expect(t.err()).toMatch(/^bad\.xfer:\d+:\d+: error XFER0405: /);
  });

  it("reads standard input and writes JSON", async () => {
    const t = host({}, "[1 2.5 true]");
    expect(await runCli(["to-json"], t.h)).toBe(0);
    expect(t.out()).toBe("[1,2.5,true]\n");
  });

  it("drops a leading byte order mark from JSON text, as TextDecoder does", async () => {
    const t = host({ "a.json": `${String.fromCharCode(0xfeff)}{"a":1}` });
    expect(await runCli(["from-json", "a.json"], t.h)).toBe(0);
    expect(t.out()).toBe("{\n    a 1\n}\n");
  });

  it("rewrites a file in place only when its canonical form differs", async () => {
    const t = host({ "loose.xfer": "{a   1}", "canonical.xfer": "{\n    a 1\n}\n" });
    const writes: string[] = [];
    const write = t.h.writeFile;
    t.h.writeFile = async (name, text) => {
      writes.push(name);
      await write(name, text);
    };
    expect(await runCli(["fmt", "--write", "loose.xfer", "canonical.xfer"], t.h)).toBe(0);
    expect(writes).toEqual(["loose.xfer"]);
    expect(t.files["loose.xfer"]).toBe("{\n    a 1\n}\n");
    expect(t.out()).toBe("");
  });

  it("reports usage errors and unreadable files with status 2", async () => {
    const t = host({});
    expect(await runCli([], t.h)).toBe(2);
    expect(t.err()).toBe(USAGE);
    expect(await runCli(["frobnicate"], t.h)).toBe(2);
    expect(await runCli(["validate", "missing.xfer"], t.h)).toBe(2);
    expect(t.err()).toContain("xfer: cannot read missing.xfer: no such file\n");
  });

  it("prints the host's version and the usage", async () => {
    const t = host({});
    expect(await runCli(["--version"], t.h)).toBe(0);
    expect(await runCli(["-h"], t.h)).toBe(0);
    expect(t.out()).toBe(`9.9.9\n${USAGE}`);
  });
});
