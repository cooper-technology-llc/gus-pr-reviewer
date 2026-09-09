import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",
    isolate: process.env["VITEST_ISOLATE"] === "true",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    maxWorkers: 4,
  },
});
