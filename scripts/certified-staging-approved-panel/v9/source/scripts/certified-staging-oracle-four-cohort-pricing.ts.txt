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

type Snapshot = Parameters<typeof independentApprovedPricing>[0];
type FourPriors = readonly [ExactQ, ExactQ, ExactQ, ExactQ];
type FourCohorts = readonly [QTriple, QTriple, QTriple, QTriple];
/** Public v3 rule: every Wednesday 05:00 KST grants exactly 10 blue, 10 purple and
 * 0 yellow pieces, independent of reroll cohort and collaboration periods. */
export const V3_WEEKLY_FIXED: QTriple = [q(10), q(10), q(0)];
const V3_RULE_ID = "schedule-kit-v3:documented-physical-supply-v2";
const PHYSICAL_LAW_VERSION = "documented-physical-supply-v2";

function weeklySupply(snapshot: Snapshot): QTriple {
  const rule = snapshot.rules[0];
  assert.ok(rule);
  if (snapshot.version === "certified-daily-v2") {
    assert.equal(rule.weeklyFixed, undefined);
    return [q(0), q(0), q(0)];
  }
  assert.equal(snapshot.version, "certified-daily-v3");
  assert.equal(rule.id, V3_RULE_ID);
  // v3 forbids finite (override) laws; only the documented physical laws remain.
  assert.ok(snapshot.laws.length > 0);
  for (const law of snapshot.laws) {
    assert.notEqual(law.kind, "finite");
    assert.equal(law.modelVersion, PHYSICAL_LAW_VERSION);
  }
  assert.deepEqual(rule.weeklyFixed, [{ lawId: "deterministic:10,10,0", count: 1 }]);
  return V3_WEEKLY_FIXED;
}

/** Four-prior recurring rate for v2 or v3 with explicitly supplied cohort expectations.
 * The weekly fixed grant enters the shop term: (normal shop + weekly) / 7. */
export function priceFourCohortSupply(
  snapshot: Snapshot,
  priors: FourPriors,
  cohorts: FourCohorts,
): QTriple {
  const weekly = weeklySupply(snapshot);
  assert.ok(priors.every((prior) => cmp(prior, q(0)) >= 0));
  assert.equal(cmp(priors.reduce(add, q(0)), q(1)), 0);
  // Reuse the historical public-rule checks and exact shop/solo terms. Removing
  // cohort-0 dispatch from its rate leaves the cohort-independent common supply.
  const frozen0 = frozenIndependentCohorts()[0];
  const rate0 = independentApprovedPricing(snapshot, [q(1), q(0), q(0)]);
  return makeTriple((color) => {
    let rate = add(rate0[color], q(-frozen0[color].n, frozen0[color].d));
    rate = add(rate, mul(weekly[color], q(1, 7)));
    for (const cohort of [0, 1, 2, 3] as const)
      rate = add(rate, mul(priors[cohort], cohorts[cohort][color]));
    return rate;
  });
}

export function independentVersionedPricing(
  snapshot: Snapshot,
  priors: IndependentPriors,
): QTriple {
  if (priors.length === 3) {
    assert.equal(snapshot.version, "certified-daily-v1");
    return independentApprovedPricing(snapshot, priors);
  }
  return priceFourCohortSupply(snapshot, priors, [
    ...frozenIndependentCohorts(),
    independentFourthCohort(),
  ]);
}
