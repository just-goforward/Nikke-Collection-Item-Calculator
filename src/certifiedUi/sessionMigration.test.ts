import { describe, expect, it } from "vitest";
import { add, div, mul, ONE, q, sum, toWire, ZERO } from "../../shared/certifiedRational";
import {
  buildCertifiedSupplySnapshot,
  DEFAULT_PERSONAL_COHORT_WEIGHTS,
} from "../../shared/certifiedSupply";
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

// Independent likelihood invariant: a zero-piece dispatch implies no kept card
// in earlier rounds. Each such round restarts the entire weighted 56-card pool.
function probabilityNoKeptCard() {
  const weights = [15, 15, 15, 3, 7, 7, 3];
  const counts = weights.map(() => 0);
  function draw(slots: number, total: number): ReturnType<typeof q> {
    if (slots === 0) return ONE;
    let mass = ZERO;
    for (const [index, weight] of weights.entries()) {
      const used = counts[index] ?? 0;
      counts[index] = used + 1;
      mass = add(mass, mul(q((4 - used) * weight, total), draw(slots - 1, total - weight)));
      counts[index] = used;
    }
    return mass;
  }
  return draw(4, 400);
}

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

describe("four-cohort legacy certified-session migration", () => {
  it.each([0, 1, 2])(
    "keeps the explicit legacy cohort %i selection in four entries",
    (selected) => {
      const { legacy } = fixture();
      const weights = [0, 1, 2].map((cohort) => toWire(q(cohort === selected ? 1 : 0)));
      const next = restoreCertifiedSession(JSON.stringify({ ...legacy, cohortWeights: weights }));
      expect(next?.cohortWeights).toEqual([...weights, toWire(ZERO)]);
      expect(next?.migrationNotice).toBe("cohort_selection_kept");
      expect(next?.stock).toEqual(legacy.stock);
      expect(next?.receipts).toEqual(legacy.receipts);
      expect(next?.outcomes).toEqual(legacy.outcomes);
    },
  );

  it("does not claim receipt replay when an empty non-point legacy mixture is reset", () => {
    const { original, legacy } = fixture();
    for (const source of [undefined, original]) {
      const next = restoreCertifiedSession(JSON.stringify({ ...legacy, receipts: [] }), source);
      expect(next?.cohortWeights).toEqual(DEFAULT_PERSONAL_COHORT_WEIGHTS);
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
        profileId: "certified-staging-v3",
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

  it("replays a cohort-dependent dispatch likelihood, while the live path resets", () => {
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
    const a = probabilityNoKeptCard();
    const a2 = mul(a, a);
    const masses = [ONE, mul(q(2), a), mul(q(3), a2), mul(a2, a)];
    const expected = masses.map((mass) => toWire(div(mass, sum(masses))));
    const replayed = restoreCertifiedSession(JSON.stringify(observed), source);
    expect(replayed?.cohortWeights).toEqual(expected);
    expect(replayed?.cohortWeights).not.toEqual(DEFAULT_PERSONAL_COHORT_WEIGHTS);
    expect(replayed?.migrationNotice).toBe("cohort_posterior_replayed");
    expect(replayed?.stock).toEqual(legacy.stock);
    const live = restoreCertifiedCalculatorSession(JSON.stringify(observed));
    expect(live?.session.cohortWeights).toEqual(DEFAULT_PERSONAL_COHORT_WEIGHTS);
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
});
