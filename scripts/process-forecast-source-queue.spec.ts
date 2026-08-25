import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("forecast source-queue processor", () => {
  it("bundles the GitHub Actions entrypoint before execution", () => {
    const root = resolve(import.meta.dirname, "..");
    const result = spawnSync(
      process.execPath,
      [resolve(root, "scripts/process-forecast-source-queue.ts"), "--check"],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("bundle check passed");
  });
});
