import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { APPROVED_PANEL_INDICES } from "../../certified-staging-approved-panel.ts";
import {
  compareValue,
  createOracleEvaluator,
  type ExactQ,
  fromWire,
  makeTriple,
  mapTriple,
  mul,
  type QTriple,
  q,
  wire,
} from "../../certified-staging-oracle.ts";
import { generateValidationCases } from "../../certified-staging-oracle-fixtures.ts";
import { priceFourCohortSupply } from "../../certified-staging-oracle-four-cohort-pricing.ts";
import { sourceIdentity } from "../v6/history.ts";
import {
  assertV3Snapshot,
  GENERATION_SOURCES,
  PHYSICAL_VERSION,
  POPULATION,
  receivedEventIds,
  validateFourCohorts,
} from "./evidence.ts";
import { type FourCohorts, independentFourCohorts } from "./physical.ts";

type FourPriors = readonly [ExactQ, ExactQ, ExactQ, ExactQ];
type WireQ = ReturnType<typeof wire>;
const ONE_SEVENTH = q(1, 7);
/** Every row carries positive cohort-3 mass. By panel position: the public
 * population mix; the original three priors scaled by 6/7 with 1/7 on cohort 3;
 * or a pure cohort-3 (three-reroll) player. */
export function panelPriors(position: number, original: QTriple): FourPriors {
  if (position % 3 === 0) return POPULATION;
  if (position % 3 === 1) {
    const scale = q(6, 7);
    return [mul(original[0], scale), mul(original[1], scale), mul(original[2], scale), ONE_SEVENTH];
  }
  return [q(0), q(0), q(0), q(1)];
}

/** Every current objective/action/gap is computed by the independent Bellman oracle
 * at prices from the independent four-cohort v3 pricing; no product result is read. */
export function calculatePanel(snapshot: CertifiedSupplySnapshot, cohorts: FourCohorts) {
  assertV3Snapshot(snapshot);
  const received = receivedEventIds(snapshot);
  // The approved asOf is a Wednesday after 05:00 KST: its weekly grant is already received.
  assert.ok(received.includes(`weekly-kits:${snapshot.coverage.currentDay}`));
  const originals = generateValidationCases();
  return APPROVED_PANEL_INDICES.map((index, position) => {
    const original = originals[index];
    assert.ok(original, `Missing approved fixture value at index ${index}`);
    // Only the approved player state (grade/level/exp/stock) is reused; the request
    // moves to the v3 snapshot's asOf.
    const { snapshot: _historical, ...smallInput } = original.input;
    const priors = panelPriors(position, original.cohortWeights);
    const cohortWeights = [
      wire(priors[0]),
      wire(priors[1]),
      wire(priors[2]),
      wire(priors[3]),
    ] as const;
    const input = {
      ...smallInput,
      asOf: snapshot.asOf,
      cohortWeights,
      receivedEventIds: received,
    };
    const rates = priceFourCohortSupply(snapshot, priors, cohorts);
    const prices = makeTriple((color) => {
      const rate = rates[color] as ExactQ;
      return q(rate.d, BigInt(input.stock[color] as number) * rate.d + rate.n);
    });
    const current = createOracleEvaluator(prices)(input);
    const difference = (first: WireQ, second: WireQ) => {
      const a = fromWire(first),
        b = fromWire(second);
      return wire(q(a.n * b.d - b.n * a.d, a.d * b.d));
    };
    const actionGaps = [...current.candidates].map(([action, value]) => ({
      action,
      optimal: compareValue(value, current) === 0,
      // Signed objective differences in lexicographic P-max/B-min/C-min order.
      P: difference(wire(current.P), wire(value.P)),
      B: difference(wire(value.B), wire(current.B)),
      C: difference(wire(value.C), wire(current.C)),
    }));
    return {
      id: original.id,
      originalIndex: index,
      input,
      expected: {
        successP: wire(current.P),
        weightedExpectedConsumptionB: wire(current.B),
        expectedTotalConsumptionC: wire(current.C),
        expectedConsumed: mapTriple(current.consumed, wire),
        action: current.action === "STOP" || current.action === "DONE" ? null : current.action,
        mask: current.ties.reduce((mask, action) => {
          if (action === "blue") return mask | 1;
          if (action === "purple") return mask | 2;
          if (action === "yellow") return mask | 4;
          return mask;
        }, 0),
        rates: mapTriple(rates, wire),
        prices: mapTriple(prices, wire),
        cohortWeights,
        actionGaps,
      },
    };
  });
}
export type ApprovedPanelRowV8 = ReturnType<typeof calculatePanel>[number];

/** Runs in a copied workspace without product modules; enumerates afresh. */
export function calculateFresh(snapshot: CertifiedSupplySnapshot) {
  const before = sourceIdentity(GENERATION_SOURCES);
  const started = performance.now();
  const cohorts = independentFourCohorts();
  const computeMs = performance.now() - started;
  const wireCohorts = [
    mapTriple(cohorts[0], wire),
    mapTriple(cohorts[1], wire),
    mapTriple(cohorts[2], wire),
    mapTriple(cohorts[3], wire),
  ] as const;
  validateFourCohorts(wireCohorts);
  const physical = {
    version: PHYSICAL_VERSION,
    generatedAt: new Date().toISOString(),
    computeMs,
    ...before,
    cohorts: wireCohorts,
    population: POPULATION.map(wire),
    rate: mapTriple(priceFourCohortSupply(snapshot, POPULATION, cohorts), wire),
  };
  const panel = calculatePanel(snapshot, cohorts);
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES), before, "Generation source drift");
  return { physical, panel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const snapshot = JSON.parse(
    readFileSync("snapshot-input.json", "utf8"),
  ) as CertifiedSupplySnapshot;
  console.log(JSON.stringify(calculateFresh(snapshot)));
}
