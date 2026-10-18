import { defineConfig } from "vitest/config";

// The CLI test spawns the built binary, so it runs after `npm run build`, not in `npm test`.
export default defineConfig({
  test: { include: ["test/cli.test.ts"], testTimeout: 30_000 },
});
