import { add, mul, type Q, q } from "../../shared/certifiedRational";
import type { ExactSupplyOutcome } from "../../shared/certifiedSupplyLaws";
import { rationalPayload, type WorkBudget } from "./budget";
import { capUnits, KIT_INDICES } from "./game";
import type { FiniteKernel } from "./kernel";
import type { Triple } from "./types";
import type { ExactValue } from "./value";

const ZERO = q(0);
const ONE = q(1);

type SupportRow = { pieces: Triple; mass: Q };
export type Support = { rows: Map<string, SupportRow>; bytes: number };
export function singleton(stock: Triple, budget: WorkBudget): Support {
  const row = { pieces: stock, mass: ONE };
  const bytes = 80 + rationalPayload(ONE);
  budget.reserve(bytes);
  return { rows: new Map([[stock.join(","), row]]), bytes };
}
export function convolve(
  before: Support,
  outcomes: readonly ExactSupplyOutcome[],
  caps: Triple,
  budget: WorkBudget,
): Support {
  const next: Support = { rows: new Map(), bytes: 0 };
  try {
    for (const row of before.rows.values())
      for (const outcome of outcomes) {
        budget.tick();
        if (outcome.mass.n === 0n) continue;
        const pieces: Triple = [
          Math.min(caps[0], row.pieces[0] + outcome.pieces[0]),
          Math.min(caps[1], row.pieces[1] + outcome.pieces[1]),
          Math.min(caps[2], row.pieces[2] + outcome.pieces[2]),
        ];
        const key = pieces.join(",");
        const mass = mul(row.mass, outcome.mass);
        const old = next.rows.get(key);
        if (old) {
          const previousBytes = rationalPayload(old.mass);
          old.mass = add(old.mass, mass);
          const delta = rationalPayload(old.mass) - previousBytes;
          next.bytes += delta;
          budget.reserve(delta);
        } else {
          next.rows.set(key, { pieces, mass });
          const bytes = 80 + key.length * 2 + rationalPayload(mass);
          next.bytes += bytes;
          budget.reserve(bytes);
          budget.support(next.rows.size);
        }
      }
    budget.release(before.bytes);
    return next;
  } catch (error) {
    budget.release(next.bytes);
    throw error;
  }
}
export function expectation(
  sid: number,
  supports: readonly Support[],
  priors: readonly [Q, Q, Q],
  kernel: FiniteKernel,
): ExactValue {
  let p = ZERO,
    b = ZERO,
    c = ZERO;
  const consumed: [Q, Q, Q] = [ZERO, ZERO, ZERO];
  for (const cohort of KIT_INDICES) {
    const prior = priors[cohort];
    if (prior.n === 0n) continue;
    const support = supports[cohort]!;
    for (const row of support.rows.values()) {
      kernel.budget.tick();
      const value = kernel.value(sid, capUnits(sid, row.pieces));
      const mass = mul(prior, row.mass);
      p = add(p, mul(mass, value.p));
      b = add(b, mul(mass, value.b));
      c = add(c, mul(mass, value.c));
      for (const k of KIT_INDICES) consumed[k] = add(consumed[k], mul(mass, value.consumed[k]));
    }
  }
  return { p, b, c, consumed, mask: 0 };
}
