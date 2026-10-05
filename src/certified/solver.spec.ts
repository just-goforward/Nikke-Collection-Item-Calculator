import { describe, expect, it } from "vitest";
import { cmp, fromWire, q, toWire } from "../../shared/certifiedRational";
import {
  buildCertifiedSupplySnapshot,
  type CertifiedSupplyEvent,
  type CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { certifiedSupplyLawPayloadBytes } from "../../shared/certifiedSupplyLaws";
import { solveCertified } from "./solver";
import type { CertifiedInput } from "./types";

const AS_OF = "2026-08-20T08:00:00.000Z";
function event(day: number, lawId: string): CertifiedSupplyEvent {
  const gameDate = new Date(Date.parse("2026-08-20T00:00:00Z") + day * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    id: `dispatch:${gameDate}`,
    gameDate,
    at: `${gameDate}T08:00:00.000Z`,
    kind: "dispatch",
    status: "confirmed",
    refs: [{ lawId, count: 1 }],
    ruleId: "test-rule",
  };
}
function snapshot(events: CertifiedSupplyEvent[] = [], zeroRate = false): CertifiedSupplySnapshot {
  const result = buildCertifiedSupplySnapshot({
    asOf: AS_OF,
    revision: "exact-test-v1",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
    sourceStatus: "healthy",
  });
  return {
    ...result,
    events,
    rules: [
      {
        id: "test-rule",
        effectiveFrom: "2020-01-01T00:00:00Z",
        effectiveUntil: null,
        dispatch: [{ lawId: zeroRate ? "deterministic:0,0,0" : "deterministic:1,1,1", count: 1 }],
        normalShop: [],
        collaborationShop: [],
        soloDays: [],
        provenance: ["exact fixture"],
      },
    ],
  };
}
function input(supply: CertifiedSupplySnapshot): CertifiedInput {
  return { grade: "SR", level: 14, exp: 0, stock: [0, 0, 0], asOf: AS_OF, snapshot: supply };
}
describe("certified physical waiting", () => {
  it("completes SR15 when zero-priced future kits cannot be used", () => {
    const request: CertifiedInput = {
      ...input(snapshot([event(1, "deterministic:10,0,0")], true)),
      level: 15,
    };
    const result = solveCertified(request);
    expect(result.status).toBe("completed");
    expect(result.current?.status).toBe("complete");
    expect(result.current?.value.successP).toEqual(toWire(q(1)));
    expect(result.current?.value.weightedExpectedConsumptionB).toEqual(toWire(q(0)));
    expect(result.current?.value.expectedTotalConsumptionC).toEqual(toWire(q(0)));
    expect(result.current?.optimalActionMask).toBe(0);
    expect(result.waiting.recommendedDays).toBe(0);
  });
  it("keeps the claim notice and suppresses N at completed SR15", () => {
    const request: CertifiedInput = {
      ...input(
        snapshot([event(0, "deterministic:10,0,0"), event(1, "deterministic:10,0,0")], true),
      ),
      level: 15,
    };
    const result = solveCertified(request);
    expect(result.current?.status).toBe("complete");
    expect(result.claimNotice?.eventIds).toEqual([event(0, "deterministic:10,0,0").id]);
    expect(result.waiting.status).toBe("claim_required");
    expect(result.waiting.recommendedDays).toBeNull();
  });

  it("certifies the physical R0 day56 boundary under the unchanged work ceilings", () => {
    const asOf = "2026-09-30T08:00:00.000Z";
    const supply = buildCertifiedSupplySnapshot({
      asOf,
      revision: "physical-R0-regression",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    });
    const receivedEventIds = supply.events
      .filter((event) => event.gameDate === supply.coverage.currentDay)
      .map((event) => event.id);
    const result = solveCertified(
      {
        grade: "R",
        level: 0,
        exp: 0,
        stock: [300, 50, 20],
        asOf,
        snapshot: supply,
        receivedEventIds,
      },
      { maxManagedPayloadBytes: 160 * 1024 * 1024 },
    );
    expect(result.current?.value.successP).toEqual({
      numerator:
        "5819945451294108124600243854934400756374258798866256360117211992203172831949070247274673927293",
      denominator:
        "18189894035458564758300781250000000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(result.current?.optimalActionMask).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.waiting.status).toBe("certified");
    expect(result.waiting.recommendedDays).toBe(56);
    expect(result.waiting.value).toBeNull();
    const witness = result.waiting.strictBoundaryWitness!;
    expect(witness.beforeValue.successP).toEqual(toWire(q(1)));
    expect(witness.afterValue.successP).toEqual(toWire(q(1)));
    expect(
      cmp(
        fromWire(witness.afterValue.weightedExpectedConsumptionB),
        fromWire(witness.beforeValue.weightedExpectedConsumptionB),
      ),
    ).toBe(-1);
    expect(
      cmp(
        fromWire(witness.afterValue.expectedTotalConsumptionC),
        fromWire(witness.beforeValue.expectedTotalConsumptionC),
      ),
    ).toBe(1);
    expect(result.diagnostics.memoEntries).toBeLessThan(100_000);
    expect(result.diagnostics.elapsedMs).toBeLessThan(15_000);
  }, 20_000);
});

describe("certified range-only waiting", () => {
  it("charges zero-price feasibility law caches against the managed ceiling", () => {
    const arrival = event(1, "regular-box-v1");
    arrival.refs = [{ lawId: "regular-box-v1", count: 63 }];
    const request: CertifiedInput = {
      ...input(snapshot([arrival], true)),
      grade: "SR",
      level: 14,
      exp: 2900,
      stock: [10, 10, 0],
      computeWaiting: false,
    };
    const maxManagedPayloadBytes =
      JSON.stringify(request).length * 2 + certifiedSupplyLawPayloadBytes() + 2048;
    const result = solveCertified(request, { maxManagedPayloadBytes });
    expect(result.status).toBe("refused");
    expect(result.current).toBeNull();
    expect(result.refusal).toEqual({ reason: "managed_payload_ceiling", phase: "pricing" });
  });

  it("selects the earliest exact date tie after a deterministic arrival", () => {
    const result = solveCertified(input(snapshot([event(1, "deterministic:0,0,10")])));
    expect(result.current?.value.successP).toEqual(toWire(q(0)));
    expect(result.waiting.status).toBe("certified");
    expect(result.waiting.recommendedDays).toBe(1);
    expect(result.waiting.value?.successP).toEqual(toWire(q(1)));
    expect(result.waiting.evaluatedDays).toHaveLength(57);
    expect(result.waiting.evidence).toContain("exact_previous_day_strict_lex_inequality");
  });
  it("keeps the single latent cohort across repeated dates", () => {
    const supply = snapshot([event(1, "cohort-test"), event(2, "cohort-test")]);
    supply.laws = [
      {
        id: "cohort-test",
        kind: "finite",
        modelVersion: "test-v1",
        outcomesByCohort: [
          [{ pieces: [0, 0, 5], mass: toWire(q(1)) }],
          [{ pieces: [5, 0, 0], mass: toWire(q(1)) }],
          [{ pieces: [0, 0, 0], mass: toWire(q(1)) }],
        ],
      },
    ];
    const result = solveCertified({
      ...input(supply),
      cohortWeights: [toWire(q(1, 2)), toWire(q(1, 2)), toWire(q(0))],
    });
    expect(result.waiting.status).toBe("certified");
    expect(result.waiting.recommendedDays).toBe(2);
    expect(result.waiting.value?.successP).toEqual(toWire(q(11, 20)));
  });
  it("retains current results and marks UNKNOWN when exact support admission fails", () => {
    const supply = snapshot([event(1, "support-test")]);
    supply.laws = [
      {
        id: "support-test",
        kind: "finite",
        modelVersion: "test-v1",
        outcomes: [
          { pieces: [0, 0, 0], mass: toWire(q(1, 2)) },
          { pieces: [0, 0, 10], mass: toWire(q(1, 2)) },
        ],
      },
    ];
    let published = false;
    const result = solveCertified(input(supply), {
      maxSupportPoints: 1,
      onCurrent: (partial) => {
        published = partial.current !== null;
      },
    });
    expect(published).toBe(true);
    expect(result.current).not.toBeNull();
    expect(result.status).toBe("partial");
    expect(result.waiting.status).toBe("unresolved");
    expect(result.waiting.reason).toBe("exact_support_limit");
    expect(result.waiting.recommendedDays).toBeNull();
  });
  it("uses only input stock today and blocks waiting until claimable rewards are received", () => {
    const result = solveCertified({
      ...input(snapshot([event(0, "deterministic:0,0,10")])),
      exp: 2900,
      stock: [10, 0, 0],
    });
    expect(result.current?.optimalActionMask).toBe(1);
    expect(result.waiting.status).toBe("claim_required");
    expect(result.waiting.recommendedDays).toBeNull();
    expect(result.claimNotice?.eventIds).toHaveLength(1);
  });
  it("allows a zero recurring rate when the initial stock gives a positive price denominator", () => {
    const result = solveCertified({ ...input(snapshot([], true)), exp: 2900, stock: [10, 0, 0] });
    expect(result.current?.status).toBe("use_certified");
    expect(result.current?.value.weightedExpectedConsumptionB).toEqual(toWire(q(1)));
    expect(result.waiting.recommendedDays).toBe(0);
  });
  it("names a zero price denominator refusal when future stock can make the color usable", () => {
    const result = solveCertified(input(snapshot([event(1, "deterministic:0,0,10")], true)));
    expect(result.status).toBe("refused");
    expect(result.refusal?.reason).toBe("zero_basis_future_usable_yellow");
  });
  it("keeps a complete declared model evaluable while recording uncertain source provenance", () => {
    const supply = snapshot([event(1, "deterministic:0,0,10")]);
    supply.sourceStatus = "uncertain";
    const result = solveCertified(input(supply));
    expect(result.waiting.status).toBe("certified");
    expect(result.waiting.recommendedDays).toBe(1);
    expect(result.waiting.evidence).toContain(
      "modeled_forecast_source_uncertain_no_automatic_delay",
    );
  });
  it("proves day zero at the unlimited optimum even when future coverage is incomplete", () => {
    const supply = snapshot();
    supply.coverage = {
      ...supply.coverage,
      future: {
        ...supply.coverage.future,
        complete: false,
        missing: ["authority_not_extended"],
      },
    };
    const result = solveCertified({ ...input(supply), exp: 2900, stock: [10, 0, 0] });
    expect(result.waiting.status).toBe("certified");
    expect(result.waiting.recommendedDays).toBe(0);
    expect(result.waiting.evidence).toContain("exact_P_B_C_equal_feasible_unlimited_optimum");
  });
  it("does not treat an incomplete future as a no-arrival proof", () => {
    const supply = snapshot();
    supply.coverage = {
      ...supply.coverage,
      future: {
        ...supply.coverage.future,
        complete: false,
        missing: ["authority_not_extended"],
      },
    };
    const result = solveCertified(input(supply));
    expect(result.waiting.status).toBe("unresolved");
    expect(result.waiting.reason).toBe("future_coverage_incomplete");
    expect(result.waiting.recommendedDays).toBeNull();
  });
});
