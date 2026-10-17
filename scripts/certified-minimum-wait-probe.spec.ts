import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../shared/certifiedSupply";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "../shared/certifiedSupplyLaws";
import { historicalV2ProbeSource, runMinimumWaitProbe } from "./certified-minimum-wait-probe";

it("derives the historical v2 probe from the product probe by replacing only its contract gate", () => {
  const source = readFileSync("src/certified/minimumWaitProbe.ts", "utf8");
  const rewritten = historicalV2ProbeSource(source);
  expect(rewritten).not.toContain("assertCertifiedRuntimeSupplySnapshot");
  expect(rewritten).toContain(
    'if (assertCertifiedSupplySnapshot(input.snapshot).version !== "certified-daily-v2") throw new Error("historical_probe_requires_certified_daily_v2");',
  );
  // Every other product line is kept verbatim.
  const kept = (text: string) =>
    text.split("\n").filter((line) => !line.includes("SupplySnapshot"));
  expect(kept(rewritten)).toEqual(kept(source));
  expect(rewritten.split("\n")).toHaveLength(source.split("\n").length);
  // A drifted gate fails closed instead of silently probing an unchecked snapshot.
  expect(() =>
    historicalV2ProbeSource(
      source.replace("assertCertifiedRuntimeSupplySnapshot(input", "x(input"),
    ),
  ).toThrow("historical_probe_rewrite_drift");
});

it("exposes a JSON probe without importing oracle expectations and fails closed on historical input", async () => {
  const asOf = "2026-10-13T08:00:00.000Z";
  const snapshot = buildCertifiedSupplySnapshot({
    asOf,
    revision: "probe-test",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
  expect(snapshot.version).toBe("certified-daily-v4");
  // A genuine v1 document: the v3-only weekly rule field and weekly events do not exist there.
  const historical = {
    ...snapshot,
    version: "certified-daily-v1" as const,
    laws: LEGACY_CERTIFIED_SUPPLY_LAWS,
    rules: snapshot.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
    events: snapshot.events.filter((event) => event.kind !== "weekly-kits"),
  };
  const result = await runMinimumWaitProbe({
    id: "historical",
    input: {
      grade: "R",
      level: 14,
      exp: 0,
      stock: [10, 0, 0],
      asOf,
      snapshot: historical,
    },
  });
  expect(result).toMatchObject({
    id: "historical",
    status: "NOTRUN",
    label: "unknown",
    reason: "unsupported_forecast_version",
    supportUnitsCapped: false,
    perDay: [],
  });
  // The historical mode is gated to v2 exactly: v1 still fails closed there.
  expect(
    await runMinimumWaitProbe(
      {
        id: "historical",
        input: { grade: "R", level: 14, exp: 0, stock: [10, 0, 0], asOf, snapshot: historical },
      },
      "historical-v2",
    ),
  ).toMatchObject({
    status: "NOTRUN",
    label: "unknown",
    reason: "historical_probe_requires_certified_daily_v2",
    perDay: [],
  });
});
