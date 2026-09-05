/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
const config = {
  cleanTempDir: "always",
  concurrency: 2,
  // The Vitest 5 name separator breaks Stryker 10's per-test filter. Its Vitest
  // adapter also returns coverage with analysis off; use the unfiltered CLI.
  testRunner: "command",
  coverageAnalysis: "off",
  mutate: ["src/hooks/solverRecoveryPolicy.ts"],
  commandRunner: {
    command: [
      "node node_modules/vitest/vitest.mjs run --configLoader runner",
      "src/hooks/solverRecoveryPolicy.test.ts",
      "src/hooks/solverRecoveryPolicy.contract.test.ts",
      "--maxWorkers 1 --no-file-parallelism",
    ].join(" "),
  },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/recovery-policy.json" },
  thresholds: {
    high: 95,
    low: 90,
    break: 90,
  },
  // Stryker 10.0.0 still calls a TypeScript API removed in TypeScript 7 while
  // rewriting tsconfig files. Pointing its optional preprocessor at an absent
  // file leaves the real tsconfig available to Vitest inside the sandbox.
  tsconfigFile: "tsconfig.stryker-compat.json",
  tempDirName: ".stryker-tmp",
};

// Manual, one-module ratchet. See docs/mutation-contract.md for the compatibility
// evidence, bounded runtime, and conditions for restoring the Vitest adapter.
export default config;
