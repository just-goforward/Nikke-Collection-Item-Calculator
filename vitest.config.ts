import { defineConfig } from "vitest/config";

const timeBudgetTestFiles = [
  "shared/certifiedSupply.spec.ts",
  "scripts/certified-staging-oracle-certificates.spec.ts",
  "src/certified/nearBoundWitness.spec.ts",
  "scripts/certified-staging-approved-panel/v5/evidence.spec.ts",
];

export default defineConfig({
  ...(process.env["SOLVER_A_VITEST_CACHE_DIR"]
    ? { cacheDir: process.env["SOLVER_A_VITEST_CACHE_DIR"] }
    : {}),
  // Exercise the server-first delivery-health path even while production builds keep it disabled.
  define: {
    __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: "true",
  },
  plugins: [
    {
      name: "preserve-vitest-cli-excludes",
      // Vitest 5 does not forward CLI exclusions to inline projects.
      configureVitest({ project, vitest }) {
        project.config.exclude = [
          ...new Set([...project.config.exclude, ...(vitest.config.cliExclude ?? [])]),
        ];
      },
    },
  ],
  test: {
    ...(process.env["SOLVER_A_VITEST_MODULE_CACHE_DIR"]
      ? { fsModuleCachePath: process.env["SOLVER_A_VITEST_MODULE_CACHE_DIR"] }
      : {}),
    // Preserve the Vitest 4 mock lifecycle while the root suite migrates to v5.
    clearMocks: false,
    coverage: {
      include: ["src/**/*.{ts,tsx}", "shared/**/*.ts"],
      exclude: ["**/*.{test,spec}.{ts,tsx}", "**/*.d.ts"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "root",
          include: [
            "src/**/*.{test,spec}.{ts,tsx}",
            "scripts/**/*.{test,spec}.ts",
            "shared/**/*.{test,spec}.ts",
          ],
          exclude: [
            "benchmarks/**",
            "e2e/**",
            "node_modules/**",
            "dist/**",
            ...timeBudgetTestFiles,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "solver-time-budgets",
          include: timeBudgetTestFiles,
          exclude: ["benchmarks/**", "e2e/**", "node_modules/**", "dist/**"],
          isolate: true,
          fileParallelism: false,
        },
      },
    ],
  },
});
