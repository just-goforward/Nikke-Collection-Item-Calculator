import { type Q, toNumber, toWire } from "../../shared/certifiedRational";
import type { CertifiedValue, ExactTriple } from "./types";
import type { ExactValue } from "./value";
export function wireTriple(values: readonly [Q, Q, Q]): ExactTriple {
  return [toWire(values[0]), toWire(values[1]), toWire(values[2])];
}
export function certifiedValueView(value: ExactValue): CertifiedValue {
  return {
    successP: toWire(value.p),
    weightedExpectedConsumptionB: toWire(value.b),
    expectedTotalConsumptionC: toWire(value.c),
    expectedConsumed: wireTriple(value.consumed),
    display: {
      successP: toNumber(value.p),
      weightedExpectedConsumptionB: toNumber(value.b),
      expectedTotalConsumptionC: toNumber(value.c),
    },
  };
}
