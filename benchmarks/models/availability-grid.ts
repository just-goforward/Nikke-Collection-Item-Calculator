import { EXPECTED_28_DAY_GAIN, type ResearchCostModel } from "../../src/solver/domain";
import { solveWithResearchCostModel } from "../../src/solver/solve";
import type { Kit, SolverInput, Stock } from "../../src/types";

const KITS: Kit[] = ["blue", "purple", "yellow"];

export const BASELINE_AVAILABILITY_CANDIDATE = {
  id: "tau0.01-h0.5-p3",
  tolerance: 0.01,
  horizonFactor: 0.5,
  horizonDays: 14,
  normPower: 3,
  role: "baseline",
} as const;

export const TOLERANCE_GRID = [0, 0.001, 0.002, 0.005, 0.01, 0.02, 0.03] as const;
export const HORIZON_FACTOR_GRID = [0, 0.25, 0.5, 0.75, 1] as const;
export const PRESERVATION_NORM_POWER_PROBES = [4, Number.POSITIVE_INFINITY] as const;
export const LOW_PRIORITY_NORM_POWER_PROBES = [2] as const;

export type AvailabilitySliderCandidate = {
  id: string;
  tolerance: number;
  horizonFactor: number;
  horizonDays: number;
  normPower: number;
  role: "baseline" | "grid" | "preservation-probe" | "sensitivity-probe";
};

export function availabilityCandidateId(
  tolerance: number,
  horizonFactor: number,
  normPower: number,
) {
  const pLabel = normPower === Number.POSITIVE_INFINITY ? "inf" : String(normPower);
  return `tau${tolerance}-h${horizonFactor}-p${pLabel}`;
}

export function buildAvailabilityGridCandidates(
  options: { includePreservationProbes?: boolean; includeSensitivityProbes?: boolean } = {},
): AvailabilitySliderCandidate[] {
  const normPowers = [
    3,
    ...(options.includePreservationProbes ? PRESERVATION_NORM_POWER_PROBES : []),
    ...(options.includeSensitivityProbes ? LOW_PRIORITY_NORM_POWER_PROBES : []),
  ];
  const candidates: AvailabilitySliderCandidate[] = [];
  for (const tolerance of TOLERANCE_GRID) {
    for (const horizonFactor of HORIZON_FACTOR_GRID) {
      for (const normPower of normPowers) {
        const isBaseline =
          tolerance === BASELINE_AVAILABILITY_CANDIDATE.tolerance &&
          horizonFactor === BASELINE_AVAILABILITY_CANDIDATE.horizonFactor &&
          normPower === BASELINE_AVAILABILITY_CANDIDATE.normPower;
        const isProbe = normPower !== 3;
        candidates.push({
          id: availabilityCandidateId(tolerance, horizonFactor, normPower),
          tolerance,
          horizonFactor,
          horizonDays: horizonFactor * 28,
          normPower,
          role: isBaseline
            ? "baseline"
            : isProbe && normPower === 2
              ? "sensitivity-probe"
              : isProbe
                ? "preservation-probe"
                : "grid",
        });
      }
    }
  }
  return candidates;
}

export function availabilityCostModelFor(
  candidate: Pick<AvailabilitySliderCandidate, "horizonFactor" | "normPower">,
): ResearchCostModel {
  return {
    kind: "availability-pnorm",
    horizonFactor: candidate.horizonFactor,
    normPower: candidate.normPower,
  };
}

export function solveAvailabilityCandidate(
  input: SolverInput,
  candidate: AvailabilitySliderCandidate,
) {
  return solveWithResearchCostModel(input, availabilityCostModelFor(candidate), undefined, {
    toleranceOverride: candidate.tolerance,
  });
}

export function journeyHorizonAnchor(expectedConsumption: Stock, stock: Stock) {
  return Math.max(
    ...KITS.map((kit) => {
      const shortfall = Math.max(0, expectedConsumption[kit] - stock[kit]);
      return (28 * shortfall) / EXPECTED_28_DAY_GAIN[kit];
    }),
  );
}
