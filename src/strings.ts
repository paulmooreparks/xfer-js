const QUOTE = 0x22;
const HASH = 0x23;

export interface Delimiter {
  readonly form: "rep" | "hash";
  readonly run: number;
}

/** The lengths of the maximal runs of `"` in the content. */
function quoteRuns(content: string): Set<number> {
  const runs = new Set<number>();
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === QUOTE) {
      n++;
    } else if (n > 0) {
      runs.add(n);
      n = 0;
    }
  }
  if (n > 0) {
    runs.add(n);
  }
  return runs;
}

/** The lengths of the runs of `#` that immediately follow a `"` in the content. */
function hashRunsAfterQuote(content: string): Set<number> {
  const runs = new Set<number>();
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === QUOTE) {
      let j = i + 1;
      while (content.charCodeAt(j) === HASH) {
        j++;
      }
      if (j > i + 1) {
        runs.add(j - i - 1);
      }
      i = j - 1;
    }
  }
  return runs;
}

const longest = (runs: ReadonlySet<number>) => Math.max(0, ...runs);

/** The smallest positive length that is not in the set, and is not 2 if `skipTwo`. */
function smallestMissing(runs: ReadonlySet<number>, skipTwo: boolean): number {
  let n = 1;
  while (runs.has(n) || (skipTwo && n === 2)) {
    n++;
  }
  return n;
}

/**
 * Chooses how to delimit a string (specification 6, rule 10). The choice is deterministic, and the
 * delimiter is always visibly longer than anything in the content:
 *
 * - no quote in the content: one quote on each side;
 * - quotes inside, but not at either end: repetition, one longer than the longest run of quotes
 *   in the content, and never two, because a run of exactly two quotes is the empty string;
 * - a quote at an end: hash-run, with one more hash than the longest run that follows a quote.
 *
 * When that length would pass the run-length limit, the smallest length of the same form that no
 * run in the content uses is taken instead. That can still pass the limit, but only for content
 * with a quote run (or a hash run after a quote) of every length up to it, which no real document
 * has. It is used anyway, because a string must always be writable; a parser enforcing the limit
 * reports XFER0604 for it, and one that accepts longer runs reads it.
 */
export function chooseDelimiter(content: string, runLimit: number): Delimiter {
  if (!content.includes('"')) {
    return { form: "rep", run: 1 };
  }
  if (!content.startsWith('"') && !content.endsWith('"')) {
    const runs = quoteRuns(content);
    const preferred = longest(runs) + 1 === 2 ? 3 : longest(runs) + 1;
    return { form: "rep", run: preferred <= runLimit ? preferred : smallestMissing(runs, true) };
  }
  const hashes = hashRunsAfterQuote(content);
  const preferred = longest(hashes) + 1;
  return { form: "hash", run: preferred <= runLimit ? preferred : smallestMissing(hashes, false) };
}

/** The text of a string literal for the content, with no escaping of any kind. */
export function writeString(content: string, runLimit: number): string {
  const { form, run } = chooseDelimiter(content, runLimit);
  if (form === "rep") {
    const quotes = '"'.repeat(run);
    return quotes + content + quotes;
  }
  const hashes = "#".repeat(run);
  return `${hashes}"${content}"${hashes}`;
}
