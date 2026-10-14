import { expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../shared/certifiedSupply";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "../shared/certifiedSupplyLaws";
import { runMinimumWaitProbe } from "./certified-minimum-wait-probe";

it("exposes a JSON probe without importing oracle expectations and fails closed on historical input", async () => {
  const asOf = "2026-10-13T08:00:00.000Z";
  const snapshot = buildCertifiedSupplySnapshot({
    asOf,
    revision: "probe-test",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
  const result = await runMinimumWaitProbe({
    id: "historical",
    input: {
      grade: "R",
      level: 14,
      exp: 0,
      stock: [10, 0, 0],
      asOf,
      snapshot: { ...snapshot, version: "certified-daily-v1", laws: LEGACY_CERTIFIED_SUPPLY_LAWS },
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
});
