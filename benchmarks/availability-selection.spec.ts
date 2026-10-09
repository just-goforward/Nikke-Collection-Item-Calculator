import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_BASELINE_ID,
  aggregateExact,
  buildCandidate,
} from "./availability-selection-evaluation";
import { renderSelectionReport } from "./availability-selection-report";
import type { ExactEntry, SelectionOutput } from "./availability-selection-types";

describe("availability selection report contracts", () => {
  it.each([
    [AVAILABILITY_BASELINE_ID, [], 0, 0],
    ["candidate", [], null, null],
    [
      "candidate",
      [
        {
          modelId: "candidate",
          scenario: "s1",
          status: "completed",
          exactLossVsA: -0.2,
          relativeLossVsA: -0.3,
        },
        {
          modelId: "candidate",
          scenario: "s2",
          status: "completed",
          exactLossVsA: 0.1,
          relativeLossVsA: 0.2,
        },
      ],
      0.1,
      0.2,
    ],
  ] as const)("preserves loss classification for %s", (modelId, entries, loss, relativeLoss) => {
    const candidate = buildCandidate(
      modelId,
      aggregateExact(entries as readonly ExactEntry[]),
      new Map(),
      new Map(),
      [],
    );
    expect(candidate.worstExactLoss).toBe(loss);
    expect(candidate.worstRelativeLoss).toBe(relativeLoss);
  });

  it.each([
    [null, "-"],
    [true, "yes"],
    [false, "no"],
  ] as const)("preserves the stage significance label for %s", (significance, label) => {
    const report: SelectionOutput = {
      kind: "availability-selection",
      version: 1,
      generatedAt: "fixed",
      source: "fixture",
      deltaPBudget: 0.005,
      guardrailTolerances: {
        depletionTolerance: 0,
        residualRelTolerance: 0,
        autonomyRelTolerance: 0,
      },
      baselineId: AVAILABILITY_BASELINE_ID,
      significanceAvailable: true,
      gateScenarioIds: [],
      candidates: [],
      stages: [
        {
          stage: "확률우선",
          modelId: "candidate",
          worstExactLoss: 0,
          worstRelativeLoss: null,
          supplyDebtCvar90: 2,
          tailSignificantImprovement: significance,
          guardrailDegraded: false,
          guardrailDegradations: [],
          riskStratumBetter: false,
        },
      ],
    };
    expect(renderSelectionReport(report)).toContain(
      `| 확률우선 | \`candidate\` | 0.000000 | n/a | 2.000 | ${label} | no |`,
    );
  });
});
