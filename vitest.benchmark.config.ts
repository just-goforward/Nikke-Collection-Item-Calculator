import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: false,
    include: ["benchmarks/**/*.{test,spec}.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 600000,
  },
});
