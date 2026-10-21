# xferlang

## 0.1.0-next.5

### Minor Changes

- f561949: The command line is also a function: `runCli(args, host)` from `xferlang/cli` runs `xfer` with files and streams the caller supplies and returns its exit status, so a browser terminal can run the same command line as the Node one. The `xfer` command itself is unchanged.

## 0.1.0-next.4

### Minor Changes

- 3bf7f48: `toJson` refuses JSON text longer than the document size limit (specification 8.1), with `XFER0601` and no text: `text` is now `string | undefined`, and `ToJsonOptions` takes `limits`. The CLI writes each file's output as soon as it is made rather than joining all of it into one string, prints nothing for a refused `to-json`, and exits 2 with `xfer: cannot write standard output` when standard output cannot be written (or exits 2 when standard error cannot).

## 0.1.0-next.3

### Patch Changes

- e001abe: `canonical` counts an empty collection as a nesting level, and counts the `xfer` head and the final line feed towards the document size limit, so its output is never refused by a parser using the same limits.

## 0.1.0-next.2

### Patch Changes

- d581659: A diagnostic message that shortens a long key or id no longer cuts a surrogate pair in two.

## 0.1.0-next.1

### Patch Changes

- 837b93f: Publish through the release workflow with provenance.
