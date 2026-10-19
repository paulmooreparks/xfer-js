---
"xferlang": minor
---

`toJson` refuses JSON text longer than the document size limit (specification 8.1), with `XFER0601` and no text: `text` is now `string | undefined`, and `ToJsonOptions` takes `limits`. The CLI writes each file's output as soon as it is made rather than joining all of it into one string, prints nothing for a refused `to-json`, and exits 2 with `xfer: cannot write standard output` when standard output cannot be written (or exits 2 when standard error cannot).
