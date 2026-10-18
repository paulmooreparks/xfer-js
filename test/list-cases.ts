// Prints the id of every suite case, one per line, sorted. Run with `npm run suite:cases`.
import { loadCases } from "./cases.ts";

const { valid, invalid } = loadCases();
const ids = [...valid, ...invalid].map((c) => c.id).sort();
process.stdout.write(`${ids.join("\n")}\n`);
