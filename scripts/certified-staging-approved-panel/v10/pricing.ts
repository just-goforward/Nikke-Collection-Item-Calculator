import assert from "node:assert/strict";
import { add, type ExactQ, mul, type QTriple, q } from "../../certified-staging-oracle.ts";
import type { FourCohorts } from "../v8/physical.ts";
import { history } from "./fixtures/input.ts";
import { medianCadence } from "./median.ts";

export type Priors = readonly [ExactQ, ExactQ, ExactQ, ExactQ];
export type Ref = { lawId: string; count: number };
type PricingSnapshot = {
  cadence: { version: string; numerator: number; denominator: number; medianDays?: number };
  rules: readonly {
    dispatch: readonly Ref[];
    normalShop: readonly Ref[];
    weeklyFixed?: readonly Ref[];
    soloDays: readonly (readonly Ref[])[];
  }[];
};
/** The dated predictor and the long-run frequency deliberately have different statistics. */
export function observedCadence() {
  const dates = history.map((row) => row[1]);
  const median = medianCadence(dates);
  let total = 0;
  for (let index = 1; index < dates.length; index += 1) {
    const current = dates[index];
    const previous = dates[index - 1];
    assert.ok(current && previous);
    total += (Date.parse(current) - Date.parse(previous)) / 86_400_000;
  }
  return { numerator: total, denominator: dates.length - 1, medianDays: median.predictionDays };
}
export function assertCadence(snapshot: PricingSnapshot) {
  const cadence = observedCadence();
  assert.equal(snapshot.cadence.version, "observed-median-v2");
  assert.equal(snapshot.cadence.numerator, cadence.numerator, "Observed mean numerator");
  assert.equal(snapshot.cadence.denominator, cadence.denominator, "Observed mean denominator");
  assert.equal(snapshot.cadence.medianDays, cadence.medianDays, "Prediction median");
  return cadence;
}
/** Public physical means, independent of product distributions and calculation code. */
export function expectedRefs(refs: readonly Ref[], priors: Priors, cohorts: FourCohorts): QTriple {
  assert.ok(priors.every((prior) => prior.n >= 0n));
  assert.deepEqual(priors.reduce(add, q(0)), q(1));
  const result: [ExactQ, ExactQ, ExactQ] = [q(0), q(0), q(0)];
  for (const ref of refs) {
    assert.ok(Number.isSafeInteger(ref.count) && ref.count >= 0);
    let gain: QTriple;
    switch (ref.lawId) {
      case "regular-box-v1":
        gain = [q(12, 5), q(1, 5), q(0)];
        break;
      case "box-ii-v1":
        gain = [q(7, 2), q(2, 5), q(1, 5)];
        break;
      case "deterministic:10,10,0":
        gain = [q(10), q(10), q(0)];
        break;
      case "dispatch-board-v1":
        gain = [0, 1, 2].map((color) =>
          priors.reduce((sum, prior, index) => {
            const value = cohorts[index]?.[color];
            assert.ok(value);
            return add(sum, mul(prior, value));
          }, q(0)),
        ) as [ExactQ, ExactQ, ExactQ];
        break;
      default:
        throw new Error(`Unsupported independent physical law: ${ref.lawId}`);
    }
    for (const color of [0, 1, 2] as const)
      result[color] = add(result[color], mul(gain[color], q(ref.count)));
  }
  return result;
}
export function recurringRate(snapshot: PricingSnapshot, priors: Priors, cohorts: FourCohorts) {
  const cadence = assertCadence(snapshot);
  assert.equal(snapshot.rules.length, 1);
  const rule = snapshot.rules[0];
  assert.ok(rule);
  assert.deepEqual(rule.dispatch, [{ lawId: "dispatch-board-v1", count: 1 }]);
  assert.deepEqual(rule.normalShop, [{ lawId: "box-ii-v1", count: 5 }]);
  assert.deepEqual(rule.weeklyFixed, [{ lawId: "deterministic:10,10,0", count: 1 }]);
  const dispatch = expectedRefs(rule.dispatch, priors, cohorts);
  const shop = expectedRefs([...rule.normalShop, ...rule.weeklyFixed], priors, cohorts);
  const solo = expectedRefs(rule.soloDays.flat(), priors, cohorts);
  assert.deepEqual(solo, [q(1382, 5), q(152, 5), q(68, 5)]);
  return ([0, 1, 2] as const).map((color) =>
    add(
      dispatch[color],
      add(mul(shop[color], q(1, 7)), mul(solo[color], q(cadence.denominator, cadence.numerator))),
    ),
  ) as [ExactQ, ExactQ, ExactQ];
}
