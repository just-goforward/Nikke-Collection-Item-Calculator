import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  frozenIndependentCohorts,
  independentApprovedPricing,
} from "./certified-staging-approved-panel.ts";
import {
  add,
  cmp,
  type ExactQ,
  fromWire,
  mul,
  type QTriple,
  q,
} from "./certified-staging-oracle.ts";
import { makeTriple, mapTriple } from "./certified-staging-oracle-tuples.ts";

export type IndependentPriors = QTriple | readonly [ExactQ, ExactQ, ExactQ, ExactQ];
type Wire = { numerator: string; denominator: string };
const COHORT3_PIN = "95e31e1b275ee966e49eb95ecccbc46df455d6dbdeaf50e550ed136c4f7615f3";

/** Exact 9e4ee70 local prototype artifact, pinned separately from product constants.
 * V6 remains a historical three-cohort publication and is never regenerated here.
 */
export function independentFourthCohort(): QTriple {
  const bytes = readFileSync(
    new URL("./certified-staging-oracle-fixtures/cohort3-dispatch-v1.json", import.meta.url),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== COHORT3_PIN)
    throw new Error("independent_cohort3_pin_mismatch");
  const fixture = JSON.parse(bytes.toString("utf8")) as {
    expectedPieces: readonly [Wire, Wire, Wire];
  };
  return mapTriple(fixture.expectedPieces, fromWire);
}

export function independentVersionedPricing(
  snapshot: Parameters<typeof independentApprovedPricing>[0],
  priors: IndependentPriors,
): QTriple {
  if (priors.length === 3) {
    assert.equal(snapshot.version, "certified-daily-v1");
    return independentApprovedPricing(snapshot, priors);
  }
  assert.equal(snapshot.version, "certified-daily-v2");
  const cohorts = [...frozenIndependentCohorts(), independentFourthCohort()] as const;
  assert.ok(priors.every((prior) => cmp(prior, q(0)) >= 0));
  assert.equal(cmp(priors.reduce(add, q(0)), q(1)), 0);
  // Reuse the historical public-rule checks and exact shop/solo terms. Removing
  // cohort-0 dispatch from its rate leaves the cohort-independent common supply.
  const rate0 = independentApprovedPricing(snapshot, [q(1), q(0), q(0)]);
  return makeTriple((color) => {
    let rate = add(rate0[color], q(-cohorts[0][color].n, cohorts[0][color].d));
    for (const cohort of [0, 1, 2, 3] as const)
      rate = add(rate, mul(priors[cohort], cohorts[cohort][color]));
    return rate;
  });
}
