# xferlang

## 0.1.0-next.3

### Patch Changes

- e001abe: `canonical` counts an empty collection as a nesting level, and counts the `xfer` head and the final line feed towards the document size limit, so its output is never refused by a parser using the same limits.

## 0.1.0-next.2

### Patch Changes

- d581659: A diagnostic message that shortens a long key or id no longer cuts a surrogate pair in two.

## 0.1.0-next.1

### Patch Changes

- 837b93f: Publish through the release workflow with provenance.
