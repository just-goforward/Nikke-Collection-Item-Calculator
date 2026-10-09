import { add, div, type Q, q } from "../../shared/certifiedRational";
import { certifiedRecurringRate } from "../../shared/certifiedSupply";
import {
  certifiedSupplyLawPayloadBytes,
  getCertifiedLawDistribution,
} from "../../shared/certifiedSupplyLaws";
import type { WorkBudget } from "./budget";
import { futureEvents } from "./events";
import type { KitIndex } from "./game";
import type { CertifiedInput, CertifiedOutput } from "./types";
import { requireInput } from "./validation";
import { wireTriple } from "./views";

const ZERO = q(0);
const ONE = q(1);
const KITS = ["blue", "purple", "yellow"] as const;
/** No epsilon: an undefined price is rejected iff that color can actually be used. */
function futureUsable(
  input: CertifiedInput,
  color: KitIndex,
  priors: readonly [Q, Q, Q],
  budget: WorkBudget,
): boolean {
  // A completed item has no feasible maintenance action, regardless of arrivals.
  if (input.grade === "SR" && input.level === 15) return false;
  if (input.stock[color] >= 10) return true;
  for (const cohort of [0, 1, 2] as const) {
    if (!priors[cohort].n) continue;
    let reachable = input.stock[color];
    for (const event of futureEvents(input))
      for (const ref of event.refs) {
        const law = getCertifiedLawDistribution(ref, cohort, {
          laws: input.snapshot.laws,
          checkBudget: budget.check,
        });
        budget.setExternalPayload(certifiedSupplyLawPayloadBytes());
        reachable += Math.max(
          ...law.filter((outcome) => outcome.mass.n > 0n).map((outcome) => outcome.pieces[color]),
        );
        if (reachable >= 10) return true;
      }
  }
  return false;
}
export function calculatePricing(
  input: CertifiedInput,
  priors: readonly [Q, Q, Q],
  budget: WorkBudget,
): { weights: readonly [Q, Q, Q]; pricing: NonNullable<CertifiedOutput["pricing"]> } {
  const basis = input.priceBasisStock ?? input.stock;
  const rates = certifiedRecurringRate(input.snapshot, input.cohortWeights, {
    laws: input.snapshot.laws,
    checkBudget: budget.check,
  });
  budget.setExternalPayload(certifiedSupplyLawPayloadBytes());
  const weight = (k: KitIndex): Q => {
    const rate = rates[k];
    requireInput(rate.n >= 0n, "negative_recurring_rate");
    const denominator = add(q(basis[k]), rate);
    if (denominator.n === 0n) {
      requireInput(!futureUsable(input, k, priors, budget), `zero_basis_future_usable_${KITS[k]}`);
      return ZERO;
    }
    return div(ONE, denominator);
  };
  const weights: [Q, Q, Q] = [weight(0), weight(1), weight(2)];
  const pricing = {
    basisStock: basis,
    recurringRate: wireTriple(rates),
    weights: wireTriple(weights),
    cohortWeights: wireTriple(priors),
  };
  return { weights, pricing };
}
