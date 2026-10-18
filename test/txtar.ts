/**
 * Reads a txtar archive into a map from entry name to content.
 *
 * A line of the form `-- name --` starts an entry, which runs to the next such line or the end
 * of the file and includes its final newline. Text before the first entry is ignored.
 */
export function readTxtar(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = text.split("\n");
  let name: string | undefined;
  let body: string[] = [];

  const finish = () => {
    if (name === undefined) {
      return;
    }
    if (entries.has(name)) {
      throw new Error(`txtar: duplicate entry "${name}"`);
    }
    entries.set(name, body.join(""));
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const last = i === lines.length - 1;
    const header = /^-- (.+?) --$/.exec(line);
    if (header) {
      finish();
      name = header[1];
      body = [];
    } else if (name !== undefined) {
      // split("\n") leaves one empty string after a final newline; it is not a line.
      if (!last) {
        body.push(`${line}\n`);
      } else if (line !== "") {
        body.push(line);
      }
    }
  }
  finish();
  return entries;
}
