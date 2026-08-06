import { EXPECTED_28_DAY_GAIN } from "../src/solver/domain";
import type { Kit, Stock } from "../src/types";

export const HP_HORIZON_FACTORS = [0.25, 0.5, 0.625, 0.75, 0.875, 1, 1.25] as const;
export const HP_NORM_POWERS = [1, 1.5, 2, 3, 4, 6, "infinity"] as const;
export const HP_TOLERANCE = 0;

export type HpNormPower = (typeof HP_NORM_POWERS)[number];

export type HpCandidate = {
  id: string;
  horizonFactor: (typeof HP_HORIZON_FACTORS)[number];
  horizonDays: number;
  normPower: HpNormPower;
  tolerance: 0;
};

export type HpSolveOutcome = "completed" | "memo_full" | "budget_exceeded" | "failure";

export type HpRootMetrics = {
  firstAction: Kit | null;
  successProbability: number;
  maxSuccessProbability: number;
  expectedConsumption: Stock;
  totalExpectedUses: number;
  referenceInteractiveF: number;
  maxSupplyDebtDays: number;
  optimizerExpectedCost: number | null;
  nodeCount: number;
};

export type HpRootScreenRecord = {
  candidateId: string;
  scenarioId: string;
  minEfOutcome: HpSolveOutcome;
  phase2Outcome: HpSolveOutcome | "not_run";
  selectedBackend: "rust-min-ef" | "rust-phase2" | null;
  metrics: HpRootMetrics | null;
  errorMessage: string | null;
  elapsedMs: number;
};

export type HpCandidateScreenSummary = {
  candidateId: string;
  completed: number;
  comparableScenarios: number;
  newFailures: number;
  recoveredScenarios: number;
  maxSuccessProbabilityLoss: number | null;
  meanTotalExpectedUses: number | null;
  worstSupplyDebtDays: number | null;
};

export const HP_CANDIDATES: HpCandidate[] = HP_HORIZON_FACTORS.flatMap((horizonFactor) =>
  HP_NORM_POWERS.map((normPower) => ({
    id: hpCandidateId(horizonFactor, normPower),
    horizonFactor,
    horizonDays: horizonFactor * 28,
    normPower,
    tolerance: HP_TOLERANCE,
  })),
);

export const HP_BASELINE_ID = hpCandidateId(0.75, 3);

export const HP_MANDATORY_SHORTLIST_IDS = new Set([
  HP_BASELINE_ID,
  ...([1, 2, 4, "infinity"] as const).map((normPower) => hpCandidateId(0.75, normPower)),
  ...([0.25, 0.5, 1, 1.25] as const).map((horizonFactor) => hpCandidateId(horizonFactor, 3)),
]);

export function hpCandidateId(horizonFactor: number, normPower: HpNormPower): string {
  return `H${formatNumber(horizonFactor)}-p${normPower === "infinity" ? "inf" : formatNumber(normPower)}`;
}

export function hpNormPowerValue(normPower: HpNormPower): number {
  return normPower === "infinity" ? Number.POSITIVE_INFINITY : normPower;
}

export function hpAvailabilityObjective(
  expectedConsumption: Stock,
  stock: Stock,
  candidate: HpCandidate,
): number {
  const ratios = (["blue", "purple", "yellow"] as const).map(
    (kit) =>
      expectedConsumption[kit] / (stock[kit] + candidate.horizonFactor * EXPECTED_28_DAY_GAIN[kit]),
  );
  const normPower = candidate.normPower;
  if (normPower === "infinity") return Math.max(...ratios);
  return ratios.reduce((sum, ratio) => sum + ratio ** normPower, 0) ** (1 / normPower);
}

export function hpCandidateById(id: string): HpCandidate {
  const candidate = HP_CANDIDATES.find((entry) => entry.id === id);
  if (!candidate) {
    throw new Error(`Unknown H/p candidate ${id}.`);
  }
  return candidate;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/^0\./, "0.");
}

export function summarizeHpScreening(
  records: readonly HpRootScreenRecord[],
): HpCandidateScreenSummary[] {
  const baselineByScenario = new Map(
    records
      .filter((record) => record.candidateId === HP_BASELINE_ID)
      .map((record) => [record.scenarioId, record]),
  );
  const candidateIds = [...new Set(records.map((record) => record.candidateId))];
  return candidateIds.map((candidateId) => {
    const candidateRecords = records.filter((record) => record.candidateId === candidateId);
    const comparable = candidateRecords.filter(
      (record) => record.metrics !== null && baselineByScenario.get(record.scenarioId)?.metrics,
    );
    const newFailures = candidateRecords.filter((record) => {
      const baseline = baselineByScenario.get(record.scenarioId);
      return baseline?.metrics !== null && record.metrics === null;
    }).length;
    const recoveredScenarios = candidateRecords.filter((record) => {
      const baseline = baselineByScenario.get(record.scenarioId);
      return baseline?.metrics === null && record.metrics !== null;
    }).length;
    return {
      candidateId,
      completed: candidateRecords.filter((record) => record.metrics !== null).length,
      comparableScenarios: comparable.length,
      newFailures,
      recoveredScenarios,
      maxSuccessProbabilityLoss:
        comparable.length === 0
          ? null
          : Math.max(
              ...comparable.map((record) => {
                const baseline = baselineByScenario.get(record.scenarioId)?.metrics;
                if (!baseline || !record.metrics) return Number.NEGATIVE_INFINITY;
                return baseline.successProbability - record.metrics.successProbability;
              }),
            ),
      meanTotalExpectedUses:
        comparable.length === 0
          ? null
          : comparable.reduce((sum, record) => sum + (record.metrics?.totalExpectedUses ?? 0), 0) /
            comparable.length,
      worstSupplyDebtDays:
        comparable.length === 0
          ? null
          : Math.max(...comparable.map((record) => record.metrics?.maxSupplyDebtDays ?? 0)),
    };
  });
}
