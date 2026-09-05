import { defineConfig } from "vitest/config";

export default defineConfig({
  // Exercise the server-first delivery-health path even while production builds keep it disabled.
  define: {
    __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: "true",
  },
  test: {
    // Preserve the Vitest 4 mock lifecycle while the root suite migrates to v5.
    clearMocks: false,
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.ts",
      "shared/**/*.{test,spec}.ts",
    ],
    exclude: ["benchmarks/**", "e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      include: ["src/**/*.{ts,tsx}", "shared/**/*.ts"],
      exclude: ["**/*.{test,spec}.{ts,tsx}", "**/*.d.ts"],
    },
  },
});
