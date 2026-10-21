---
"xferlang": minor
---

The command line is also a function: `runCli(args, host)` from `xferlang/cli` runs `xfer` with files and streams the caller supplies and returns its exit status, so a browser terminal can run the same command line as the Node one. The `xfer` command itself is unchanged.
