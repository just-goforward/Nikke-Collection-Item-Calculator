/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
const config = {
  cleanTempDir: "always",
  testRunner: "vitest",
  mutate: ["src/hooks/solverRecoveryPolicy.ts", "src/hooks/solverRecovery.ts"],
  vitest: {
    configFile: "vitest.config.ts",
    related: true,
  },
  reporters: ["clear-text", "progress"],
  thresholds: {
    high: 80,
    low: 60,
    break: 0,
  },
  // Stryker 10.0.0 still calls a TypeScript API removed in TypeScript 7 while
  // rewriting tsconfig files. Pointing its optional preprocessor at an absent
  // file leaves the real tsconfig available to Vitest inside the sandbox.
  tsconfigFile: "tsconfig.stryker-compat.json",
  tempDirName: ".stryker-tmp",
};

// Manual check: rerun when recovery decisions, deadlines, backend transitions,
// Worker error traits, or their focused tests change. Keep this out of CI until
// the baseline is stable and the runtime cost is justified.
export default config;
