/// <reference types="node" />

import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { SOLO_RAID_CADENCE_SUMMARY, SOLO_RAID_ROUND_HISTORY } from "./soloRaidCadence";

async function bundledConsumer(body: string) {
  const result = await build({
    stdin: {
      contents: `import * as cadence from "./shared/soloRaidCadence.ts";\n${body}`,
      resolveDir: process.cwd(),
      sourcefile: "cadence-consumer.ts",
      loader: "ts",
    },
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2022",
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("cadence_consumer_output_missing");
  return output.text;
}

describe("tree-shakeable cadence seed initialization", () => {
  it("preserves every published round and its summary", () => {
    expect(createHash("sha256").update(JSON.stringify(SOLO_RAID_ROUND_HISTORY)).digest("hex")).toBe(
      "e732727c41f0de035898a4fe8ed069875218ba902f5fc306ee48c9a59b948176",
    );
    expect(SOLO_RAID_CADENCE_SUMMARY).toEqual({
      rounds: 40,
      intervals: 39,
      medianDays: 28,
      meanDays: 1197 / 39,
      minimumDays: 21,
      maximumDays: 42,
      frequency: {
        21: 2,
        22: 1,
        23: 1,
        26: 1,
        27: 1,
        28: 17,
        29: 1,
        34: 1,
        35: 9,
        36: 1,
        41: 1,
        42: 3,
      },
    });
  });

  it("still initializes the summary when a bundled consumer uses it", async () => {
    const code = await bundledConsumer("globalThis.summary = cadence.SOLO_RAID_CADENCE_SUMMARY;");
    const context: { summary?: unknown } = {};
    runInNewContext(code, context);
    expect(context.summary).toEqual(SOLO_RAID_CADENCE_SUMMARY);
  });

  it.each([
    [["2026-01-01"], "solo_raid_history_too_short"],
    [["2026-01-02", "2026-01-01"], "solo_raid_history_not_strictly_increasing"],
    [["invalid", "2026-01-22"], "solo_raid_game_date_invalid"],
    [["2026-02-30", "2026-03-30"], "solo_raid_game_date_invalid"],
  ] as const)("retains validation for an unused result from %j", async (dates, error) => {
    const code = await bundledConsumer(
      `cadence.summarizeSoloRaidCadence(${JSON.stringify(dates)});`,
    );
    expect(() => runInNewContext(code)).toThrow(error);
  });
});
