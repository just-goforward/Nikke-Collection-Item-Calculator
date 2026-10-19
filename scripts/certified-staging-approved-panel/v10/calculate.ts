import assert from "node:assert/strict";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { createOracleEvaluator, q, wire } from "../../certified-staging-oracle.ts";
import { generateValidationCases } from "../../certified-staging-oracle-fixtures.ts";
import type { FourCohorts } from "../v8/physical.ts";
import { history, seasons } from "./fixtures/input.ts";
import { medianPrediction } from "./median.ts";
import { expectedRefs, type Priors, recurringRate } from "./pricing.ts";

/** Same 24 approved player states as the historical panel; no historical prices. */
const INDICES = [
  0, 1, 3, 4, 8, 15, 17, 21, 26, 29, 30, 31, 61, 73, 99, 137, 211, 313, 517, 731, 991, 1237, 1619,
  1999,
];
export function calculatePanel(snapshot: CertifiedSupplySnapshot, cohorts: FourCohorts) {
  const originals = generateValidationCases();
  return INDICES.map((index, position) => {
    const original = originals[index];
    assert.ok(original);
    const priors: Priors =
      position % 2 ? [q(0), q(0), q(0), q(1)] : [q(1, 7), q(2, 7), q(3, 7), q(1, 7)];
    const rates = recurringRate(snapshot, priors, cohorts);
    const { snapshot: _old, ...state } = original.input;
    const input = {
      ...state,
      asOf: snapshot.asOf,
      cohortWeights: priors.map(wire),
      receivedEventIds: snapshot.events
        .filter((event) => event.gameDate === snapshot.coverage.currentDay && event.at <= snapshot.asOf)
        .map((event) => event.id),
    };
    const prices = rates.map((rate, color) => {
      const stock = input.stock[color];
      assert.ok(stock !== undefined);
      return q(rate.d, BigInt(stock) * rate.d + rate.n);
    }) as ReturnType<typeof recurringRate>;
    const result = createOracleEvaluator(prices)(input);
    return {
      id: original.id,
      input,
      expected: {
        P: wire(result.P),
        B: wire(result.B),
        C: wire(result.C),
        action: result.action,
        ties: result.ties,
        consumed: result.consumed.map(wire),
        rates: rates.map(wire),
        prices: prices.map(wire),
      },
    };
  });
}

/** Dated waiting boundaries and grant means supplement, not replace, the Bellman panel.
 * This is not a certification of minimum-wait solver optimality. */
export function calculateBoundaries(snapshot: CertifiedSupplySnapshot, cohorts: FourCohorts) {
  const dates = history.map((row) => row[1]);
  const anchor = seasons[1];
  const predict = (asOf: string) => medianPrediction(dates, anchor[1], anchor[2], asOf);
  const original = Date.parse(predict(snapshot.asOf).start);
  const nextReset = Math.floor((original + 4 * 3600000) / 86400000) * 86400000 + 20 * 3600000;
  return {
    waitingProof: "UNVERIFIED_NOT_REGENERATED",
    predictions: [original - 1, original, original + 1, nextReset - 1, nextReset].map((at) => {
      const asOf = new Date(at).toISOString();
      const prediction = predict(asOf);
      return {
        asOf,
        start: prediction.start,
        end: prediction.end,
        offsetDays: prediction.offsetDays,
      };
    }),
    grants: snapshot.events
      .filter((event) => event.kind === "grant")
      .map((event) => ({
        id: event.id,
        at: event.at,
        expected: expectedRefs(event.refs, [q(1), q(0), q(0), q(0)], cohorts).map(wire),
      })),
  };
}
