import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("./expected-failures.txt", import.meta.url));

/** The ids of the cases the implementation is not yet expected to pass. See expected-failures.txt. */
export function loadExpectedFailures(): Set<string> {
  const ids = new Set<string>();
  for (const raw of readFileSync(FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (line !== "" && !line.startsWith("#")) {
      ids.add(line);
    }
  }
  return ids;
}
