import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

export function stopTestDirectory(prefix: string) {
  const root = resolve(process.env["FORECAST_STOP_TEST_ROOT"] ?? ".tmp/forecast-stop-only-tests");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}
