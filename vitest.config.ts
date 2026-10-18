import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/cli.test.ts", "node_modules/**"],
    // Generous, because CI runners are slower than a developer's machine and several tests parse
    // multi-megabyte documents. A hang still fails, after thirty seconds.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 95 },
    },
  },
});
