import { defineConfig } from "vitest/config";

// Node-side checks: CPU regression proxy (T12) and static Wrangler configuration.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    clearMocks: false,
    include: ["src/**/*.spec.ts"],
    fileParallelism: false,
  },
});
