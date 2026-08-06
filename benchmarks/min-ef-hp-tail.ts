import { cvarUpperTail } from "./metrics";
import {
  holmBonferroniWorseningDecisions,
  pairedBootstrapCvarImprovement,
} from "./tail-statistics";

export const HP_TAIL_POLICY = {
  id: "paired_crn_cvar90_bootstrap_holm_v1",
  cvarAlpha: 0.9,
  confidence: 0.95,
  holmAlpha: 0.05,
  resamples: 10_000,
  bootstrapSeed: 20260805,
} as const;

export type HpTailPanelSamples = {
  panelId: string;
  baseline: number[];
  candidate: number[];
};

export type HpTailGateResult = {
  passed: boolean;
  hasStrictImprovement: boolean;
  panels: Array<{
    panelId: string;
    baselineCvar90: number;
    candidateCvar90: number;
    pointImprovement: number;
    confidenceLower: number;
    confidenceUpper: number;
    worseningAdjusted: boolean;
    improvementAdjusted: boolean;
  }>;
};

export type HpTailWinnerSelection = {
  selectedCandidateId: string | null;
  pointBestCandidateId: string | null;
  statisticallyTiedCandidateIds: string[];
};

export function evaluateHpTailGate(panels: readonly HpTailPanelSamples[]): HpTailGateResult {
  if (panels.length === 0) {
    return { passed: false, hasStrictImprovement: false, panels: [] };
  }
  const provisional = panels.map((panel) => {
    if (panel.baseline.length === 0 || panel.baseline.length !== panel.candidate.length) {
      throw new Error(`Tail panel ${panel.panelId} requires equal, non-empty CRN samples.`);
    }
    const display = pairedBootstrapCvarImprovement(panel.baseline, panel.candidate, {
      alpha: HP_TAIL_POLICY.cvarAlpha,
      resamples: HP_TAIL_POLICY.resamples,
      confidence: HP_TAIL_POLICY.confidence,
      seed: HP_TAIL_POLICY.bootstrapSeed,
    });
    return { panel, display };
  });
  const worseningDecisions = new Map(
    holmBonferroniWorseningDecisions(
      provisional.map(({ panel, display }) => ({
        id: panel.panelId,
        adversePValue: display.adversePValue,
      })),
      HP_TAIL_POLICY.holmAlpha,
    ).map((decision) => [decision.id, decision]),
  );
  const improvementDecisions = new Map(
    holmBonferroniWorseningDecisions(
      provisional.map(({ panel, display }) => ({
        id: panel.panelId,
        adversePValue: display.reverseAdversePValue,
      })),
      HP_TAIL_POLICY.holmAlpha,
    ).map((decision) => [decision.id, decision]),
  );
  const records = provisional.map(({ panel, display }) => ({
    panelId: panel.panelId,
    baselineCvar90: cvarUpperTail(panel.baseline, HP_TAIL_POLICY.cvarAlpha),
    candidateCvar90: cvarUpperTail(panel.candidate, HP_TAIL_POLICY.cvarAlpha),
    pointImprovement: display.pointImprovement,
    confidenceLower: display.confidenceLower,
    confidenceUpper: display.confidenceUpper,
    worseningAdjusted: worseningDecisions.get(panel.panelId)?.confirmedWorsening ?? false,
    improvementAdjusted: improvementDecisions.get(panel.panelId)?.confirmedWorsening ?? false,
  }));
  const hasStrictImprovement = records.some((record) => record.improvementAdjusted);
  return {
    passed: records.every((record) => !record.worseningAdjusted) && hasStrictImprovement,
    hasStrictImprovement,
    panels: records,
  };
}

export function selectHpTailWinner(
  candidates: ReadonlyArray<{
    candidateId: string;
    maxPanelCvar90: number;
    baselineDistance: number;
  }>,
  indistinguishable: (leftId: string, rightId: string) => boolean,
): HpTailWinnerSelection {
  const pointBest = [...candidates].sort(
    (left, right) =>
      left.maxPanelCvar90 - right.maxPanelCvar90 ||
      left.candidateId.localeCompare(right.candidateId),
  )[0];
  if (!pointBest) {
    return {
      selectedCandidateId: null,
      pointBestCandidateId: null,
      statisticallyTiedCandidateIds: [],
    };
  }
  const tied = candidates.filter(
    (candidate) =>
      candidate.candidateId === pointBest.candidateId ||
      indistinguishable(pointBest.candidateId, candidate.candidateId),
  );
  const selected = [...tied].sort(
    (left, right) =>
      left.baselineDistance - right.baselineDistance ||
      left.candidateId.localeCompare(right.candidateId),
  )[0];
  return {
    selectedCandidateId: selected?.candidateId ?? pointBest.candidateId,
    pointBestCandidateId: pointBest.candidateId,
    statisticallyTiedCandidateIds: tied.map((candidate) => candidate.candidateId),
  };
}
