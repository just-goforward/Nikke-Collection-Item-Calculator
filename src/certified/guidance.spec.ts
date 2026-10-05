import { describe, expect, it } from "vitest";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { solveCertified } from "./solver";
import type { CertifiedInput } from "./types";

const asOf = "2026-09-30T08:00:00.000Z";
const snapshot = buildCertifiedSupplySnapshot({
  asOf,
  revision: "review6-large-current",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
});
const receivedEventIds = snapshot.events
  .filter((e) => e.gameDate === snapshot.coverage.currentDay)
  .map((e) => e.id);
describe("moderate physical inventories", () => {
  for (const [grade, stock] of [
    ["R", [600, 100, 40]],
    ["R", [1000, 200, 100]],
    ["SR", [800, 150, 60]],
  ] as const)
    it(`${grade} ${stock.join("/")} returns current under unchanged limits`, () => {
      const input: CertifiedInput = {
        grade,
        level: 0,
        exp: 0,
        stock,
        asOf,
        snapshot,
        receivedEventIds,
        computeWaiting: false,
      };
      const out = solveCertified(input, { maxManagedPayloadBytes: 160 * 1024 * 1024 });
      expect(out.current, out.refusal?.reason).not.toBeNull();
      expect(out.diagnostics.memoEntries).toBeLessThanOrEqual(250000);
      expect(out.diagnostics.managedPayloadBytes).toBeLessThanOrEqual(160 * 1024 * 1024);
    }, 15000);
});
