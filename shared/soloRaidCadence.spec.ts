/// <reference types="node" />

import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  predictMedianSoloRaid,
  SOLO_RAID_CADENCE_SUMMARY,
  SOLO_RAID_ROUND_HISTORY,
} from "./soloRaidCadence";

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

describe("median v2 prediction", () => {
  const confirmedRounds = [
    ...SOLO_RAID_ROUND_HISTORY,
    { round: 41, startGameDate: "2026-09-24", status: "as_announced" as const, sourceFeedId: 0 },
    { round: 42, startGameDate: "2026-10-15", status: "as_announced" as const, sourceFeedId: 0 },
  ];
  const input = {
    confirmedRounds,
    previousStart: "2026-10-15T12:00:00+09:00",
    previousEnd: "2026-10-22T04:59:59+09:00",
    asOf: "2026-10-18T12:00:00+09:00",
  };
  it("predicts S43 and the second-most-frequent alternative without Thursday snapping", () => {
    const result = predictMedianSoloRaid(input);
    expect(result.summary.intervals).toBe(41);
    expect(result.summary.frequency[28]).toBe(17);
    expect(result.summary.frequency[35]).toBe(10);
    expect(result.primary).toMatchObject({
      label: "prediction",
      intervalDays: 28,
      start: "2026-11-12T03:00:00.000Z",
      end: "2026-11-18T19:59:59.000Z",
      expectedNotice: "2026-11-06T08:00:00.000Z",
    });
    expect(result.secondary).toMatchObject({ label: "prediction", intervalDays: 35 });
  });
  it("uses the interruption instant, not the originally announced end", () => {
    expect(
      predictMedianSoloRaid({ ...input, interruptionAt: "2026-10-15T17:00:00+09:00" }).primary.end,
    ).toBe("2026-11-12T08:00:00.000Z");
  });
  it("shifts at the 05:00 KST game-day boundary", () => {
    const before = predictMedianSoloRaid({ ...input, asOf: "2026-11-13T04:59:59+09:00" });
    const after = predictMedianSoloRaid({ ...input, asOf: "2026-11-13T05:00:00+09:00" });
    expect(before.primary).toMatchObject({ status: "공지 대기", offsetDays: 1 });
    expect(after.primary.offsetDays).toBe(2);
  });
  it("floors an even median to whole days", () => {
    const rounds = ["2026-01-01", "2026-01-29", "2026-02-27"].map((startGameDate, index) => ({
      round: index + 1,
      startGameDate,
      status: "as_announced" as const,
      sourceFeedId: 0,
    }));
    expect(
      predictMedianSoloRaid({
        confirmedRounds: rounds,
        previousStart: "2026-02-27T12:00:00+09:00",
        previousEnd: "2026-03-06T04:59:59+09:00",
        asOf: "2026-03-01T12:00:00+09:00",
      }).primary.intervalDays,
    ).toBe(28);
  });
});
