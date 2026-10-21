import { defineConfig } from "tsdown";

export default defineConfig([
  {
    // cli-core is cli/run.ts, the CLI as a function, published as "xferlang/cli" so a browser
    // terminal can run the same command line as the Node one.
    entry: { index: "src/index.ts", "cli-core": "cli/run.ts" },
    format: ["esm", "cjs"],
    platform: "neutral",
    target: "es2022",
    dts: true,
    clean: true,
    outDir: "dist",
  },
  {
    entry: { cli: "cli/main.ts" },
    format: ["esm"],
    platform: "node",
    target: "es2022",
    dts: false,
    clean: false,
    outDir: "dist",
    banner: "#!/usr/bin/env node",
  },
]);
