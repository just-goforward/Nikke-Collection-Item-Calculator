import { describe, expect, it } from "vitest";
import { q } from "../../shared/certifiedRational";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { BoundArena } from "./boundArena";
import { WorkBudget } from "./budget";
import { CAPS, EDGES, encode, minPositiveUses, TERMINAL } from "./game";
import { GuidanceArithmetic } from "./guidanceArithmetic";
import { guidedState } from "./guidanceDomain";
import { FiniteKernel } from "./kernel";
import { PrimaryGuidance } from "./primaryGuidance";
import { solveCertified } from "./solver";

const sid = encode("SR", 14, 0);
const invariant = "certified_game_great_probability_invariant";

function withInvalidGreat(p: number, run: () => void): void {
  const row = EDGES[sid]!;
  const [, great, normal] = row[0];
  EDGES[sid] = [[p, great, normal], row[1], row[2]];
  try {
    run();
  } finally {
    EDGES[sid] = row;
  }
}

describe("positive great precondition for singleton primary candidates", () => {
  it("rejects a zero-success singleton rather than choosing USE over STOP", () => {
    withInvalidGreat(0, () => {
      const budget = new WorkBudget({}, performance.now());
      const arithmetic = new GuidanceArithmetic([1n, 1n, 1n], budget);
      const arena = (): BoundArena => BoundArena.create(sid, [1, 0, 0], true, budget)!;
      expect(() => {
        const primary = new PrimaryGuidance(budget, arithmetic, arena);
        return primary.mask(sid, guidedState(sid, [1, 0, 0]));
      }).toThrow(invariant);
    });
  });

  it("uses the same named precondition at the finite kernel boundary", () => {
    for (const p of [0, -1, 0.5, 1001, NaN, Infinity]) {
      withInvalidGreat(p, () => {
        const budget = new WorkBudget({}, performance.now());
        expect(() => new FiniteKernel([q(1), q(1), q(1)], budget)).toThrow(invariant);
        expect(budget.memoEntries).toBe(0);
      });
    }
  });

  it("returns a named current refusal with no value or N for an unsupported model", () => {
    const asOf = "2026-09-30T08:00:00.000Z";
    const snapshot = buildCertifiedSupplySnapshot({
      asOf,
      revision: "positive-great-invariant-test",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    });
    withInvalidGreat(0, () => {
      const result = solveCertified({
        grade: "SR",
        level: 14,
        exp: 0,
        stock: [10, 0, 0],
        asOf,
        snapshot,
        computeWaiting: false,
      });
      expect(result.status).toBe("refused");
      expect(result.refusal).toEqual({ reason: invariant, phase: "current" });
      expect(result.current).toBeNull();
      expect(result.waiting.recommendedDays).toBeNull();
    });
  });

  it("has a positive all-great continuation after every feasible first kit", () => {
    for (let state = 0; state < TERMINAL; state++) {
      const needed = minPositiveUses(state);
      for (const [p, great] of EDGES[state]!) {
        expect(Number.isInteger(p) && p > 0 && p <= 1000).toBe(true);
        expect(minPositiveUses(great)).toBe(needed - 1);
        for (const capacity of CAPS[great]!) expect(capacity).toBeGreaterThanOrEqual(needed - 1);
      }
    }
  });
});
