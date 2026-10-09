import type { CertifiedOutput } from "../src/certified/types.ts";
import { cmp, fromWire, q, type Triple } from "./certified-staging-oracle.ts";
import { independentPhysicalRecurringRates } from "./certified-staging-oracle-physical-supply.ts";
import { makeTriple } from "./certified-staging-oracle-tuples.ts";

/** Product physical-rule/default-prior check, including P=0 states whose costs cannot expose bad prices. */
export function verifyPhysicalPricing(output: CertifiedOutput, raw: Triple) {
  if (!output.pricing)
    return { status: output.current ? "FAIL" : "NOTRUN", failures: ["pricing_not_returned"] };
  const rates = independentPhysicalRecurringRates();
  const prices = makeTriple((color) =>
    q(rates[color].d, BigInt(raw[color]) * rates[color].d + rates[color].n),
  );
  const failures: string[] = [];
  for (const color of [0, 1, 2] as const) {
    if (output.pricing.basisStock[color] !== raw[color]) failures.push(`raw_basis_${color}`);
    if (cmp(fromWire(output.pricing.recurringRate[color]), rates[color]) !== 0)
      failures.push(`recurring_rate_${color}`);
    if (cmp(fromWire(output.pricing.weights[color]), prices[color]) !== 0)
      failures.push(`fixed_price_${color}`);
    if (cmp(fromWire(output.pricing.cohortWeights[color]), q(1, 3)) !== 0)
      failures.push(`default_cohort_prior_${color}`);
  }
  return { status: failures.length ? "FAIL" : "PASS", failures };
}
