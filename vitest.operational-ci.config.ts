import { defineConfig } from "vitest/config";
import OperationalReporter from "./e2e/operational-vitest-reporter";
import { privateDirectory } from "./e2e/operational-report.mjs";

export default defineConfig({
  cacheDir: privateDirectory("numerical-boundary-cache"),
  test: {
    include: ["src/certified/wasmBackend.spec.ts"],
    clearMocks: false,
    environment: "node",
    // Intercepted logs enter Vitest task.logs before reporters can bound them.
    disableConsoleIntercept: true,
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    allowOnly: false,
    reporters: [new OperationalReporter()],
  },
});
