import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
    // `server/dist` can remain after a local build. It contains copied test
    // files, which must never run alongside the TypeScript source suite.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
