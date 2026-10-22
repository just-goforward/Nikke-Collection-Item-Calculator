import assert from "node:assert/strict";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { createOracleEvaluator, makeTriple, q, wire } from "../../certified-staging-oracle.ts";
import { generateValidationCases } from "../../certified-staging-oracle-fixtures.ts";
import { history, seasons } from "../v10/fixtures/input.ts";
import { medianPrediction } from "../v10/median.ts";
import type { ThreeCohorts } from "./physical.ts";
import { expectedRefs, PRIORS, recurringRate } from "./pricing.ts";

const INDICES = [
  0, 1, 3, 4, 8, 15, 17, 21, 26, 29, 30, 31, 61, 73, 99, 137, 211, 313, 517, 731, 991, 1237, 1619,
  1999,
];

/** Only 0/1/2 rerolls are enumerated by the independent ordered-history oracle.
 * No product probabilities, prices, solver values or fourth cohort are inputs. */
export function calculatePanel(snapshot: CertifiedSupplySnapshot, cohorts: ThreeCohorts) {
  const rates = recurringRate(snapshot, cohorts);
  const originals = generateValidationCases();
  return INDICES.map((index) => {
    const original = originals[index];
    assert.ok(original);
    const { snapshot: _historical, ...state } = original.input;
    const input = {
      ...state,
      asOf: snapshot.asOf,
      cohortWeights: [wire(PRIORS[0]), wire(PRIORS[1]), wire(PRIORS[2])] as const,
      receivedEventIds: snapshot.events
        .filter(
          (event) => event.gameDate === snapshot.coverage.currentDay && event.at <= snapshot.asOf,
        )
        .map((event) => event.id),
    };
    const prices = makeTriple((color) => {
      const rate = rates[color];
      const stock = input.stock[color];
      assert.ok(rate && stock !== undefined);
      return q(rate.d, BigInt(stock) * rate.d + rate.n);
    });
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

/** Dated predictions and grant means are not a minimum-wait optimality proof. */
export function calculateBoundaries(snapshot: CertifiedSupplySnapshot, cohorts: ThreeCohorts) {
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
        expected: expectedRefs(event.refs, cohorts).map(wire),
      })),
  };
}
