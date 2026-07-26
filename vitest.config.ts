import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts", "scripts/**/*.{test,spec}.ts"],
    exclude: ["benchmarks/**", "e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      include: ["src/**/*.{ts,tsx}", "shared/**/*.ts"],
      exclude: ["**/*.{test,spec}.{ts,tsx}", "**/*.d.ts"],
    },
  },
});
