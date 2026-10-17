import { describe, expect, it } from "vitest";
import { parseWranglerJson } from "./apply-forecast-d1-migrations.ts";
import { migrations, result, sqliteRunner } from "./forecast-migration-test-fixtures.ts";
import { legacyDatabase } from "./forecast-migration-v27-fixtures.ts";

const latest = migrations.at(-1)?.version ?? 0;

describe("Wrangler D1 JSON output", () => {
  // Captured from wrangler 4.150.0 `d1 execute --remote --file --json` with piped stdout.
  const spinner = [
    "├ Checking if file needs uploading",
    "│",
    "├ 🌀 Uploading 49b5dc06-37ae-4245-896c-daea98562ed8.42db9b1b72d75b95.sql",
    "│ 🌀 Uploading complete.",
    "│",
    "",
  ].join("\n");

  it("accepts plain JSON and JSON after the non-interactive spinner preamble", () => {
    const payload = [{ success: true, results: [] }];
    expect(parseWranglerJson(JSON.stringify(payload))).toEqual(payload);
    expect(parseWranglerJson(`${spinner}${JSON.stringify(payload, null, 2)}\n`)).toEqual(payload);
    expect(parseWranglerJson(spinner.replaceAll("\n", "\r\n") + JSON.stringify(payload))).toEqual(
      payload,
    );
  });

  it.each([
    "",
    spinner,
    `warning: unexpected\n${JSON.stringify([])}`,
    `${spinner}[{"success": true,`,
  ])("rejects missing, truncated or unexpected output: %j", (stdout) => {
    expect(() => parseWranglerJson(stdout)).toThrow("Wrangler returned invalid D1 JSON.");
  });

  it("applies file migrations whose Wrangler output carries the spinner preamble", () => {
    const db = legacyDatabase(latest - 1);
    const { spawn, run } = sqliteRunner(db);
    const base = spawn.getMockImplementation();
    spawn.mockImplementation((command, args, options) => {
      const reply = base?.(command, args, options) ?? result("", { status: 1 });
      return args.includes("--file") ? { ...reply, stdout: spinner + reply.stdout } : reply;
    });
    run();
    expect(
      db.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.["version"],
    ).toBe(latest);
  });
});
