import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
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
