import { describe, expect, it } from "vitest";
import { q, toWire } from "../../shared/certifiedRational";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { LEGACY_CERTIFIED_SUPPLY_LAWS } from "../../shared/certifiedSupplyLaws";
import {
  restoreCertifiedCalculatorSession,
  serializeCertifiedCalculatorSession,
} from "./calculatorSessionPersistence";
import {
  createCertifiedSession,
  dismissCertifiedMigrationNotice,
  recordCertifiedOutcome,
  restoreCertifiedSession,
} from "./session";

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
    rules: built.rules.map(({ weeklyFixed: _weeklyFixed, ...rule }) => rule),
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

describe("fixed-policy certified-session migration", () => {
  it.each([0, 1, 2])(
    "discards the explicit legacy cohort %i selection without changing the ledger",
    (selected) => {
      const { legacy } = fixture();
      const weights = [0, 1, 2].map((cohort) => toWire(q(cohort === selected ? 1 : 0)));
      const next = restoreCertifiedSession(JSON.stringify({ ...legacy, cohortWeights: weights }));
      expect(next).not.toHaveProperty("cohortWeights");
      expect(next?.migrationNotice).toBe("cohort_prior_reset");
      expect(next?.stock).toEqual(legacy.stock);
      expect(next?.receipts).toEqual(legacy.receipts);
      expect(next?.outcomes).toEqual(legacy.outcomes);
    },
  );

  it("does not claim receipt replay when an empty non-point legacy mixture is reset", () => {
    const { original, legacy } = fixture();
    for (const source of [undefined, original]) {
      const next = restoreCertifiedSession(JSON.stringify({ ...legacy, receipts: [] }), source);
      expect(next).not.toHaveProperty("cohortWeights");
      expect(next?.migrationNotice).toBe("cohort_prior_reset");
    }
  });
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
        profileId: "certified-staging-v4",
        migrationNotice: "cohort_prior_reset",
        stock: legacy.stock,
        state: legacy.state,
        receipts: legacy.receipts,
        retiredReceiptIds: legacy.retiredReceiptIds,
        outcomes: legacy.outcomes,
      });
      expect(restoreCertifiedSession(JSON.stringify(next))).toEqual(next);
      expect(next).not.toHaveProperty("cohortWeights");
    }
  });

  it("preserves retired receipts without replay or adding stock twice", () => {
    const { original, legacy } = fixture();
    const next = restoreCertifiedSession(JSON.stringify(legacy), original);
    expect(next).not.toHaveProperty("cohortWeights");
    expect(next?.migrationNotice).toBe("cohort_prior_reset");
    expect(next?.stock).toEqual(legacy.stock);
    expect(next?.state).toEqual(legacy.state);
    expect(next?.outcomes).toEqual(legacy.outcomes);
    expect(next?.receipts).toEqual(legacy.receipts);
  });

  it("never applies a cohort-dependent receipt likelihood, even with its original source", () => {
    const { original, legacy } = fixture();
    const event = original.events[0];
    if (!event) throw new Error("missing original event");
    const source = {
      ...original,
      events: [{ ...event, refs: [{ lawId: "dispatch-board-v1", count: 1 }] }],
    };
    const observed = {
      ...legacy,
      receipts: [{ eventId: event.id, at: event.at, pieces: [0, 0, 0], alreadyInStock: true }],
    };
    const replayed = restoreCertifiedSession(JSON.stringify(observed), source);
    expect(replayed).not.toHaveProperty("cohortWeights");
    expect(replayed?.migrationNotice).toBe("cohort_prior_reset");
    expect(replayed?.receipts).toEqual(observed.receipts);
    expect(replayed?.stock).toEqual(legacy.stock);
    const live = restoreCertifiedCalculatorSession(JSON.stringify(observed));
    expect(live?.session).not.toHaveProperty("cohortWeights");
    expect(live?.session.migrationNotice).toBe("cohort_prior_reset");
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

  it("persists dismissal without changing progression, stock or receipt history", () => {
    const { legacy } = fixture();
    const restored = restoreCertifiedSession(JSON.stringify(legacy));
    if (!restored) throw new Error("missing restored session");
    const dismissed = dismissCertifiedMigrationNotice(restored);
    const saved = serializeCertifiedCalculatorSession(dismissed, null);
    const next = restoreCertifiedCalculatorSession(saved)?.session;
    expect(next).not.toHaveProperty("migrationNotice");
    expect(next?.state).toEqual(restored.state);
    expect(next?.stock).toEqual(restored.stock);
    expect(next?.receipts).toEqual(restored.receipts);
    expect(next?.outcomes).toEqual(restored.outcomes);
  });

  it.each(["certified-staging-v2", "certified-staging-v3"])(
    "discards all four-cohort selections and posteriors from %s",
    (profileId) => {
      const { legacy } = fixture();
      for (const values of [
        [1, 0, 0, 0],
        [0, 0, 0, 1],
        [1, 2, 3, 1],
        [4, 3, 2, 1],
      ]) {
        const total = values.reduce((a, b) => a + b, 0);
        const old = {
          ...legacy,
          version: 2,
          profileId,
          cohortWeights: values.map((value) => toWire(q(value, total))),
        };
        const next = restoreCertifiedSession(JSON.stringify(old));
        expect(next).toMatchObject({
          id: old.id,
          state: old.state,
          stock: old.stock,
          outcomes: old.outcomes,
          receipts: old.receipts,
          retiredReceiptIds: old.retiredReceiptIds,
          migrationNotice: "cohort_prior_reset",
        });
        expect(next).not.toHaveProperty("cohortWeights");
      }
    },
  );
});
