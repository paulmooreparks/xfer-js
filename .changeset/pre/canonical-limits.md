---
"xferlang": patch
---

`canonical` counts an empty collection as a nesting level, and counts the `xfer` head and the final line feed towards the document size limit, so its output is never refused by a parser using the same limits.
