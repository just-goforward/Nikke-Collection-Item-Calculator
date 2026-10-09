import { beforeAll, describe, expect, it } from "vitest";
import type { CertifiedSupplySnapshot } from "../shared/certifiedSupply";
import type { CollectionState, Kit } from "../shared/game";
import { solveCertified } from "../src/certified/solver";
import type { CertifiedInput, CertifiedOutput, Triple } from "../src/certified/types";
import {
  acknowledgeCertifiedReceipt,
  type CertifiedSession,
  createCertifiedSession,
  recordCertifiedOutcome,
  restoreCertifiedSession,
} from "../src/certifiedUi/session";
import { prepareCertifiedForecast } from "../src/lib/certifiedForecast";
import {
  cmp,
  compareValue,
  createOracleEvaluator,
  independentFailure,
  independentProbability,
  independentSuccess,
  makeTriple,
  mapTriple,
  type QTriple,
  q,
  wire,
} from "./certified-staging-oracle.ts";
import { independentPhysicalRecurringRates } from "./certified-staging-oracle-physical-supply.ts";

const AS_OF = "2026-09-30T08:00:00.000Z";
const KITS = ["blue", "purple", "yellow"] as const;
let snapshot: CertifiedSupplySnapshot;
let rates: QTriple;

beforeAll(async () => {
  snapshot = await prepareCertifiedForecast(AS_OF);
  rates = independentPhysicalRecurringRates();
});

function initial(
  state: CollectionState = { grade: "SR", level: 14, exp: 0 },
  stock: Triple = [45, 0, 0],
) {
  const session = createCertifiedSession(snapshot.revision, state, stock);
  const today = snapshot.events.find((event) => event.id === "dispatch:2026-09-30");
  if (!today) throw new Error("approved_today_dispatch_missing");
  return acknowledgeCertifiedReceipt(session, today, AS_OF);
}

function request(
  session: CertifiedSession,
  options: Pick<CertifiedInput, "priceBasisStock" | "batchLimit"> = {},
): CertifiedInput {
  // Public request default: the current raw stock becomes the new price basis.
  // Fixed comparison prices are supplied only while checking one original offer.
  return {
    ...session.state,
    stock: session.stock,
    asOf: AS_OF,
    snapshot,
    cohortWeights: session.cohortWeights,
    receivedEventIds: session.receipts.map((receipt) => receipt.eventId),
    computeWaiting: false,
    batchLimit: 10,
    ...options,
  };
}

function prices(stock: Triple): QTriple {
  return makeTriple((color) => {
    const rate = rates[color as 0 | 1 | 2];
    return q(rate.d, BigInt(stock[color as 0 | 1 | 2]) * rate.d + rate.n);
  });
}

function checkCurrent(output: CertifiedOutput, session: CertifiedSession, fixedPrices: QTriple) {
  expect(output.status).toBe("completed");
  const current = output.current;
  const pricing = output.pricing;
  if (!current || !pricing) throw new Error("missing_current_or_pricing");
  const independent = createOracleEvaluator(fixedPrices)({
    ...session.state,
    stock: session.stock,
  });
  expect(current.value).toMatchObject({
    successP: wire(independent.P),
    weightedExpectedConsumptionB: wire(independent.B),
    expectedTotalConsumptionC: wire(independent.C),
    expectedConsumed: mapTriple(independent.consumed, wire),
  });
  expect(current.kit).toBe(
    independent.action === "STOP" || independent.action === "DONE" ? null : independent.action,
  );
  expect(current.optimalActionMask).toBe(
    independent.ties.reduce((mask, kit) => {
      if (kit === "blue") return mask | 1;
      if (kit === "purple") return mask | 2;
      if (kit === "yellow") return mask | 4;
      return mask;
    }, 0),
  );
  expect(pricing.recurringRate).toEqual(mapTriple(rates, wire));
  expect(pricing.weights).toEqual(mapTriple(fixedPrices, wire));
  expect(pricing.cohortWeights).toEqual(session.cohortWeights);
  return { current, independent, pricing };
}

function record(session: CertifiedSession, kit: Kit, outcome: "normal" | "great") {
  const color = KITS.indexOf(kit);
  const expectedState =
    outcome === "normal"
      ? independentFailure(session.state.grade, session.state.level, session.state.exp, color)
      : independentSuccess(session.state.grade, session.state.level);
  const expectedStock = mapTriple(
    session.stock,
    (pieces, index) => pieces - (index === color ? 10 : 0),
  );
  const next = recordCertifiedOutcome(
    session,
    kit,
    outcome,
    new Date(Date.parse(AS_OF) + session.outcomes.length * 1000).toISOString(),
  );
  expect(next.state).toEqual(expectedState);
  expect(next.stock).toEqual(expectedStock);
  expect(next.outcomes.at(-1)).toMatchObject({
    kit,
    outcome,
    before: session.state,
    after: expectedState,
  });
  expect(next.outcomes).toHaveLength(session.outcomes.length + 1);
  expect(next.receipts).toEqual(session.receipts);
  expect(next.cohortWeights).toEqual(session.cohortWeights);
  return next;
}

function restoreAndReplan(session: CertifiedSession) {
  const restored = restoreCertifiedSession(JSON.stringify(session));
  expect(restored).toEqual(session);
  if (!restored) throw new Error("valid_session_failed_restore");
  const input = request(restored);
  expect(input).not.toHaveProperty("priceBasisStock");
  const next = checkCurrent(solveCertified(input), restored, prices(restored.stock));
  expect(next.pricing.basisStock).toEqual(restored.stock);
  return next;
}

function normalPrefix(session: CertifiedSession, count: number, originalStock: Triple, kit: Kit) {
  const fixed = prices(originalStock);
  let next = session;
  for (let index = 0; index < count; index++) {
    const checked = checkCurrent(
      solveCertified(request(next, { priceBasisStock: originalStock })),
      next,
      fixed,
    );
    expect(checked.independent.ties).toContain(kit);
    const candidate = checked.independent.candidates.get(kit);
    if (!candidate) throw new Error("offered_action_not_feasible");
    expect(compareValue(candidate, checked.independent)).toBe(0);
    const probability = independentProbability(
      next.state.grade,
      next.state.level,
      KITS.indexOf(kit),
    );
    expect(cmp(probability, q(1))).toBeLessThan(0);
    next = record(next, kit, "normal");
    // A newly submitted request follows UI default repricing, independently of
    // the original offer's fixed-price NORMAL-path continuation proof above.
    restoreAndReplan(next);
  }
  return next;
}

describe("certified multi-use offer through persisted public API replanning", () => {
  it("keeps every NORMAL prefix tied-optimal at the original fixed prices, consumes40pieces and retains5", () => {
    const start = initial();
    const offered = checkCurrent(
      solveCertified(request(start)),
      start,
      prices(start.stock),
    ).current;
    expect(offered.kit).toBe("blue");
    expect(offered.uses).toBe(4);
    expect(offered.pieces).toBe(40);
    const final = normalPrefix(start, offered.uses, start.stock, "blue");
    expect(final.state).toEqual({ grade: "SR", level: 14, exp: 800 });
    expect(final.stock).toEqual([5, 0, 0]);
    expect(final.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "normal",
      "normal",
      "normal",
      "normal",
    ]);
    expect(start.stock).toEqual([45, 0, 0]);
    expect(start.outcomes).toHaveLength(0);
    const replanned = restoreAndReplan(final);
    expect(replanned.current.status).toBe("preserve");
    expect(replanned.current.uses).toBe(0);
    expect(() => recordCertifiedOutcome(final, "blue", "normal", AS_OF)).toThrow(
      "insufficient_stock",
    );
  });

  it.each([0, 1, 2, 3])(
    "GREAT after %i NORMAL results consumes exactly one additional use and persists/replans completion",
    (prefixLength) => {
      const start = initial();
      expect(solveCertified(request(start)).current?.uses).toBe(4);
      const prefix = normalPrefix(start, prefixLength, start.stock, "blue");
      const completed = record(prefix, "blue", "great");
      expect(completed.stock).toEqual([45 - 10 * (prefixLength + 1), 0, 0]);
      expect(completed.stock[0] % 10).toBe(5);
      expect(completed.state).toEqual({ grade: "SR", level: 15, exp: 0 });
      expect(completed.outcomes.filter((outcome) => outcome.outcome === "great")).toHaveLength(1);
      expect(restoreAndReplan(completed).current.status).toBe("complete");
      expect(() => recordCertifiedOutcome(completed, "blue", "great", AS_OF)).toThrow(
        "collection_complete_or_conversion_required",
      );
    },
  );
});

describe("offer stopping boundaries with the same persisted session path", () => {
  it("stops a deterministic GREAT offer after one use despite spare stock", () => {
    const start = initial({ grade: "SR", level: 14, exp: 0 }, [5, 0, 45]);
    const offered = checkCurrent(
      solveCertified(request(start)),
      start,
      prices(start.stock),
    ).current;
    expect(offered.kit).toBe("yellow");
    expect(independentProbability("SR", 14, 2)).toEqual(q(1));
    expect(offered.uses).toBe(1);
    expect(offered.pieces).toBe(10);
    const completed = record(start, "yellow", "great");
    expect(completed.stock).toEqual([5, 0, 35]);
    expect(restoreAndReplan(completed).current.uses).toBe(0);
  });

  it("ends the original offer on an ordinary level change, then independently reprices the next request", () => {
    const start = initial({ grade: "SR", level: 13, exp: 2900 });
    const offered = checkCurrent(
      solveCertified(request(start)),
      start,
      prices(start.stock),
    ).current;
    expect(offered.kit).toBe("blue");
    expect(offered.uses).toBe(1);
    const next = normalPrefix(start, 1, start.stock, "blue");
    expect(next.state).toEqual({ grade: "SR", level: 14, exp: 100 });
    expect(next.stock).toEqual([35, 0, 0]);
    const replanned = restoreAndReplan(next);
    expect(replanned.current.kit).toBe("blue");
    expect(replanned.current.uses).toBe(3);
    expect(cmp(prices(next.stock)[0], prices(start.stock)[0])).toBeGreaterThan(0);
  });

  it("honors a two-use batch limit although another fixed-price NORMAL continuation is tied-optimal", () => {
    const start = initial();
    const offered = checkCurrent(
      solveCertified(request(start, { batchLimit: 2 })),
      start,
      prices(start.stock),
    ).current;
    expect(offered.uses).toBe(2);
    expect(offered.pieces).toBe(20);
    const next = normalPrefix(start, 2, start.stock, "blue");
    const fixedContinuation = checkCurrent(
      solveCertified(request(next, { priceBasisStock: start.stock })),
      next,
      prices(start.stock),
    );
    expect(fixedContinuation.independent.ties).toContain("blue");
    expect(fixedContinuation.current.uses).toBe(2);
    expect(next.stock).toEqual([25, 0, 0]);
    expect(next.state).toEqual({ grade: "SR", level: 14, exp: 400 });
    const replanned = restoreAndReplan(next);
    expect(replanned.current.uses).toBe(2);
    expect(cmp(prices(next.stock)[0], prices(start.stock)[0])).toBeGreaterThan(0);
  });
});
