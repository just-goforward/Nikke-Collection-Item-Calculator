import { describe, expect, it } from "vitest";
import {
  buildCertifiedSupplySnapshot,
  DEFAULT_PERSONAL_COHORT_WEIGHTS,
} from "../../shared/certifiedSupply";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "../../shared/certifiedSupplyLaws";
import { restoreCertifiedCalculatorSession } from "./calculatorSessionPersistence";
import { createCertifiedSession, recordCertifiedOutcome, restoreCertifiedSession } from "./session";

function fixture() {
  const built = buildCertifiedSupplySnapshot({
    asOf: "2026-09-30T04:00:00Z",
    revision: "immutable-original",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
  const originalEvent = built.events.find((event) => event.kind === "dispatch");
  if (!originalEvent) throw new Error("missing original event");
  const event = { ...originalEvent, refs: [{ lawId: "deterministic:3,0,0", count: 1 }] };
  const original = {
    ...built,
    version: "certified-daily-v1" as const,
    laws: LEGACY_CERTIFIED_SUPPLY_LAWS,
    events: [event],
  };
  const session = recordCertifiedOutcome(
    createCertifiedSession(original.revision, { grade: "SR", level: 2, exp: 0 }, [40, 2, 1]),
    "blue",
    "normal",
    "2026-09-30T04:00:00Z",
  );
  const legacy = {
    ...session,
    version: 1,
    profileId: "certified-staging-v1",
    cohortWeights: [
      { numerator: "1", denominator: "3" },
      { numerator: "1", denominator: "3" },
      { numerator: "1", denominator: "3" },
    ],
    receipts: [{ eventId: event.id, at: event.at, pieces: [3, 0, 0], alreadyInStock: true }],
    retiredReceiptIds: [event.id],
  };
  return { original, legacy };
}

describe("four-cohort legacy certified-session migration", () => {
  it("resets only the inferred weights if original or retired-event definitions are missing", () => {
    const { original, legacy } = fixture();
    for (const source of [
      undefined,
      { ...original, events: [] },
      { ...original, revision: "replacement" },
    ]) {
      const next = restoreCertifiedSession(JSON.stringify(legacy), source);
      expect(next).toMatchObject({
        version: 2,
        profileId: "certified-staging-v2",
        cohortWeights: DEFAULT_PERSONAL_COHORT_WEIGHTS,
        migrationNotice: "cohort_prior_reset",
        stock: legacy.stock,
        state: legacy.state,
        receipts: legacy.receipts,
        retiredReceiptIds: legacy.retiredReceiptIds,
        outcomes: legacy.outcomes,
      });
      expect(restoreCertifiedSession(JSON.stringify(next))).toEqual(next);
    }
  });

  it("can replay a retired receipt from its complete original law without adding stock twice", () => {
    const { original, legacy } = fixture();
    const next = restoreCertifiedSession(JSON.stringify(legacy), original);
    expect(next?.cohortWeights).toEqual(DEFAULT_PERSONAL_COHORT_WEIGHTS);
    expect(next?.migrationNotice).toBe("cohort_posterior_replayed");
    expect(next?.stock).toEqual(legacy.stock);
    expect(next?.state).toEqual(legacy.state);
    expect(next?.outcomes).toEqual(legacy.outcomes);
    expect(next?.receipts).toEqual(legacy.receipts);
  });

  it("does not invent a fourth law for a known historical three-cohort finite law", () => {
    const { original, legacy } = fixture();
    const event = original.events[0];
    if (!event) throw new Error("missing original event");
    const point = [{ pieces: [3, 0, 0] as const, mass: { numerator: "1", denominator: "1" } }];
    const source = {
      ...original,
      events: [{ ...event, refs: [{ lawId: "old-finite", count: 1 }] }],
      laws: [
        ...original.laws,
        {
          id: "old-finite",
          kind: "finite" as const,
          modelVersion: "original",
          outcomes: point,
          outcomesByCohort: [point, point, point] as const,
        },
      ],
    };
    expect(restoreCertifiedSession(JSON.stringify(legacy), source)?.migrationNotice).toBe(
      "cohort_prior_reset",
    );
  });

  it("migrates the persisted envelope without discarding receipts or history", () => {
    const { legacy } = fixture();
    const restored = restoreCertifiedCalculatorSession(JSON.stringify(legacy));
    expect(restored?.session.stock).toEqual(legacy.stock);
    expect(restored?.session.receipts).toEqual(legacy.receipts);
    expect(restored?.session.outcomes).toEqual(legacy.outcomes);
    expect(restored?.session.migrationNotice).toBe("cohort_prior_reset");
  });
});
