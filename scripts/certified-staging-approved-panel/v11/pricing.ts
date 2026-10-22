import assert from "node:assert/strict";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { add, type ExactQ, mul, type QTriple, q } from "../../certified-staging-oracle.ts";
import { assertCadence, type Ref } from "../v10/pricing.ts";
import type { ThreeCohorts } from "./physical.ts";

export const PRIORS: QTriple = [q(1, 6), q(2, 6), q(3, 6)];

/** Public physical means, not product laws, prices or projection arithmetic. */
export function expectedRefs(refs: readonly Ref[], cohorts: ThreeCohorts): QTriple {
  assert.equal(cohorts.length, 3);
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
        gain = ([0, 1, 2] as const).map((color) =>
          PRIORS.reduce((sum, prior, index) => {
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

export function recurringRate(snapshot: CertifiedSupplySnapshot, cohorts: ThreeCohorts): QTriple {
  assert.equal(snapshot.version, "certified-daily-v5");
  assert.ok(snapshot.provenance.includes("schedule-kit-v5"));
  assert.ok(!snapshot.provenance.includes("schedule-kit-v4"));
  const cadence = assertCadence(snapshot);
  assert.equal(snapshot.rules.length, 1);
  const rule = snapshot.rules[0];
  assert.ok(rule);
  assert.equal(rule.id, "schedule-kit-v5:documented-physical-supply-v2");
  assert.ok(snapshot.events.every((event) => event.ruleId === rule.id));
  assert.deepEqual(rule.dispatch, [{ lawId: "dispatch-board-v1", count: 1 }]);
  assert.deepEqual(rule.normalShop, [{ lawId: "box-ii-v1", count: 5 }]);
  assert.deepEqual(rule.weeklyFixed, [{ lawId: "deterministic:10,10,0", count: 1 }]);
  // Seven dated raid rewards: day 1 = 12 regular; day 2 = 4 regular + 8 II;
  // days 3..7 = 12 II each. Check distribution, not only an aggregate total.
  assert.deepEqual(rule.soloDays, [
    [{ lawId: "regular-box-v1", count: 12 }],
    [
      { lawId: "regular-box-v1", count: 4 },
      { lawId: "box-ii-v1", count: 8 },
    ],
    ...Array.from({ length: 5 }, () => [{ lawId: "box-ii-v1", count: 12 }]),
  ]);
  const dispatch = expectedRefs(rule.dispatch, cohorts);
  const shop = expectedRefs([...rule.normalShop, ...rule.weeklyFixed], cohorts);
  const solo = expectedRefs(rule.soloDays.flat(), cohorts);
  return ([0, 1, 2] as const).map((color) =>
    add(
      dispatch[color],
      add(mul(shop[color], q(1, 7)), mul(solo[color], q(cadence.denominator, cadence.numerator))),
    ),
  ) as [ExactQ, ExactQ, ExactQ];
}
