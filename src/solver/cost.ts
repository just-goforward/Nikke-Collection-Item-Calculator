import type { KitVector, ResearchCostModel, Strategy } from "./domain";
import {
  EXPECTED_28_DAY_GAIN,
  KIT_ORDER,
  STRICT_EPSILON,
  SUPPLY_AVAILABILITY_PARAMS,
} from "./domain";

export function legacySupplyCostScore(vector: KitVector) {
  return KIT_ORDER.reduce((sum, kit) => sum + vector[kit] / EXPECTED_28_DAY_GAIN[kit], 0);
}

function availabilityRatio(consumption: number, availability: number) {
  if (availability > 0) return consumption / availability;
  return consumption > STRICT_EPSILON ? Number.POSITIVE_INFINITY : 0;
}

function availabilityCostScoreWithParams(
  vector: KitVector,
  stockPieces: KitVector,
  model: Extract<ResearchCostModel, { kind: "availability-pnorm" }> = {
    kind: "availability-pnorm",
  },
) {
  // Supply Phase 1 heuristic:
  // R_i = current stock pieces_i + horizon * active forecast profile reference gain_i
  // cost = (sum((expected consumption_i / R_i) ^ p)) ^ (1 / p)
  //
  // The schedule profile is a Solo-day-3-pivoted supply reference, not always unclaimed future
  // inventory. Solo days 1/2 use the accumulated reference window from the previous Solo day 3;
  // day 3 and later use the current/future window through the next Solo day 2.
  //
  // This is deterministic and stable for each memoized (state, stock), but it is not a proof of
  // global whole-route p-norm optimality. The memoized continuation is parent-independent, so
  // prior route consumption is not part of the state. If this approximation becomes a real
  // problem in benchmark data, the practical refinement path is shadow-price fixed-point passes,
  // not expanding the MDP state with cumulative consumption.
  const horizonFactor =
    typeof model.horizonFactor === "number" && Number.isFinite(model.horizonFactor)
      ? Math.max(0, model.horizonFactor)
      : SUPPLY_AVAILABILITY_PARAMS.horizon;
  const normPower = model.normPower ?? SUPPLY_AVAILABILITY_PARAMS.normPower;
  const expectedGain = model.expectedGain ?? EXPECTED_28_DAY_GAIN;

  const ratios = KIT_ORDER.map((kit) =>
    availabilityRatio(vector[kit], stockPieces[kit] + horizonFactor * expectedGain[kit]),
  );

  if (normPower === Number.POSITIVE_INFINITY) return Math.max(...ratios);
  if (normPower <= 0) return Number.POSITIVE_INFINITY;

  const powered = ratios.reduce((sum, ratio) => {
    return sum + ratio ** normPower;
  }, 0);
  return powered ** (1 / normPower);
}

export function availabilityCostScore(
  vector: KitVector,
  stockPieces: KitVector,
  expectedGain: KitVector = EXPECTED_28_DAY_GAIN,
) {
  return availabilityCostScoreWithParams(vector, stockPieces, {
    kind: "availability-pnorm",
    expectedGain,
  });
}

export function researchCostScore(
  vector: KitVector,
  stockPieces: KitVector,
  model: ResearchCostModel,
) {
  if (model.kind === "availability-pnorm")
    return availabilityCostScoreWithParams(vector, stockPieces, model);
  return KIT_ORDER.reduce((sum, kit) => {
    const price = Number(model.prices[kit]);
    if (!Number.isFinite(price) || price < 0) return Number.POSITIVE_INFINITY;
    return sum + price * vector[kit];
  }, 0);
}

export function resourceCostScore(pressure: number, supplyCost: number, strategy: Strategy) {
  if (strategy !== "supply") return pressure;
  return supplyCost;
}
