import { EXPECTED_28_DAY_GAIN, SUPPLY_AVAILABILITY_PARAMS } from "../src/solver/domain";
import type { Kit, Stock } from "../src/types";
import type { TrajectorySample } from "./evaluator/trajectory";

const KITS = ["blue", "purple", "yellow"] as const satisfies readonly Kit[];

export function availabilityPnormObjective(expectedConsumption: Stock, initialStock: Stock) {
  return KITS.reduce((sum, kit) => {
    const availability =
      initialStock[kit] + SUPPLY_AVAILABILITY_PARAMS.horizon * EXPECTED_28_DAY_GAIN[kit];
    return sum + (expectedConsumption[kit] / availability) ** SUPPLY_AVAILABILITY_PARAMS.normPower;
  }, 0);
}

export function supplyDebtDays(consumption: Stock): Stock {
  return Object.fromEntries(
    KITS.map((kit) => {
      const gain28 = EXPECTED_28_DAY_GAIN[kit];
      return [kit, Math.max(0, consumption[kit] - gain28) / (gain28 / 28)];
    }),
  ) as Stock;
}

export function maxSupplyDebtDays(consumption: Stock) {
  const debt = supplyDebtDays(consumption);
  return Math.max(...KITS.map((kit) => debt[kit]));
}

export function deficitVolumeDays(consumption: Stock) {
  const debt = supplyDebtDays(consumption);
  return KITS.reduce((sum, kit) => sum + debt[kit], 0);
}

export function percentile(values: number[], fraction: number) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.max(0, Math.min(1, fraction));
  const index = (sorted.length - 1) * clamped;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return Number.NaN;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

export function cvarUpperTail(values: number[], alpha = 0.9) {
  if (values.length === 0) return Number.NaN;
  const threshold = percentile(values, alpha);
  const tail = values.filter((value) => value >= threshold);
  if (tail.length === 0) return threshold;
  return tail.reduce((sum, value) => sum + value, 0) / tail.length;
}

export type TrajectoryTailSummary = {
  runs: number;
  completionRate: number;
  meanConsumption: Stock;
  residualP05: Stock;
  residualP10: Stock;
  autonomyDaysP05: number;
  autonomyDaysP10: number;
  depletionProbability: number;
  maxSupplyDebtDaysCvar90: number;
  meanMaxSupplyDebtDays: number;
  meanDeficitVolumeDays: number;
  manualEntryExposureRate: number;
  expectedManualEntries: number;
  successAttemptSelectionRate: number;
  expectedSuccessAttemptSelections: number;
};

export function summarizeTrajectories(samples: TrajectorySample[]): TrajectoryTailSummary {
  const runs = samples.length;
  if (runs === 0) {
    return {
      runs: 0,
      completionRate: Number.NaN,
      meanConsumption: { blue: Number.NaN, purple: Number.NaN, yellow: Number.NaN },
      residualP05: { blue: Number.NaN, purple: Number.NaN, yellow: Number.NaN },
      residualP10: { blue: Number.NaN, purple: Number.NaN, yellow: Number.NaN },
      autonomyDaysP05: Number.NaN,
      autonomyDaysP10: Number.NaN,
      depletionProbability: Number.NaN,
      maxSupplyDebtDaysCvar90: Number.NaN,
      meanMaxSupplyDebtDays: Number.NaN,
      meanDeficitVolumeDays: Number.NaN,
      manualEntryExposureRate: Number.NaN,
      expectedManualEntries: Number.NaN,
      successAttemptSelectionRate: Number.NaN,
      expectedSuccessAttemptSelections: Number.NaN,
    };
  }

  const totalConsumption = { blue: 0, purple: 0, yellow: 0 };
  for (const sample of samples) {
    for (const kit of KITS) totalConsumption[kit] += sample.consumption[kit];
  }

  return {
    runs,
    completionRate: samples.filter((sample) => sample.completed).length / runs,
    meanConsumption: Object.fromEntries(
      KITS.map((kit) => [kit, totalConsumption[kit] / runs]),
    ) as Stock,
    residualP05: Object.fromEntries(
      KITS.map((kit) => [
        kit,
        percentile(
          samples.map((sample) => sample.remainingStock[kit]),
          0.05,
        ),
      ]),
    ) as Stock,
    residualP10: Object.fromEntries(
      KITS.map((kit) => [
        kit,
        percentile(
          samples.map((sample) => sample.remainingStock[kit]),
          0.1,
        ),
      ]),
    ) as Stock,
    autonomyDaysP05: percentile(
      samples.map((sample) => sample.minAutonomyDays),
      0.05,
    ),
    autonomyDaysP10: percentile(
      samples.map((sample) => sample.minAutonomyDays),
      0.1,
    ),
    depletionProbability: samples.filter((sample) => sample.anyKitDepleted).length / runs,
    maxSupplyDebtDaysCvar90: cvarUpperTail(
      samples.map((sample) => maxSupplyDebtDays(sample.consumption)),
      0.9,
    ),
    meanMaxSupplyDebtDays:
      samples.reduce((sum, sample) => sum + maxSupplyDebtDays(sample.consumption), 0) / runs,
    meanDeficitVolumeDays:
      samples.reduce((sum, sample) => sum + deficitVolumeDays(sample.consumption), 0) / runs,
    manualEntryExposureRate: samples.filter((sample) => sample.manualEntryExposed).length / runs,
    expectedManualEntries: samples.reduce((sum, sample) => sum + sample.manualEntries, 0) / runs,
    successAttemptSelectionRate:
      samples.filter((sample) => sample.successAttemptSelectionExposed).length / runs,
    expectedSuccessAttemptSelections:
      samples.reduce((sum, sample) => sum + sample.successAttemptSelections, 0) / runs,
  };
}
