import { describe, expect, it } from "vitest";
import type { HpCandidate } from "./min-ef-hp-model";
import type { HpExactGateResult } from "./min-ef-hp-quality";
import type { HpStudyReport } from "./min-ef-hp-report";
import { summarizeDynamicHpGates } from "./summarize-dynamic-hp-gates";

describe("dynamic H/p exact gate summary", () => {
  it("aggregates completed profile gates without granting adoption authority", () => {
    const report = fixtureReport();
    const summary = summarizeDynamicHpGates(
      [{ id: "approved-00", report }],
      "2026-08-28T00:00:00.000Z",
    );

    expect(summary).toMatchObject({
      kind: "dynamic-hp-exact-gate-summary",
      version: 1,
      profileCount: 1,
      allProfilesComplete: true,
      candidateCount: 3,
      decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    });
    expect(summary.candidates).toEqual([
      {
        candidateId: "H0.5-p3",
        status: "screened_out",
        profilesScreened: 1,
        profilesShortlisted: 0,
        exactNotSelected: 1,
        exactPassed: 0,
        exactFailed: 0,
        exactIncomplete: 0,
      },
      {
        candidateId: "H0.75-p3",
        status: "passed_all_profiles",
        profilesScreened: 1,
        profilesShortlisted: 1,
        exactNotSelected: 0,
        exactPassed: 1,
        exactFailed: 0,
        exactIncomplete: 0,
      },
      {
        candidateId: "H1-p3",
        status: "rejected",
        profilesScreened: 1,
        profilesShortlisted: 1,
        exactNotSelected: 0,
        exactPassed: 0,
        exactFailed: 1,
        exactIncomplete: 0,
      },
    ]);
  });
});

function fixtureReport(): HpStudyReport {
  const candidate = (id: string): HpCandidate => {
    const horizonFactor =
      id === "H1-p3" ? (1 as const) : id === "H0.5-p3" ? (0.5 as const) : (0.75 as const);
    return {
      id,
      horizonFactor,
      horizonDays: horizonFactor * 28,
      normPower: 3 as const,
      tolerance: 0 as const,
    };
  };
  const gate = (status: "passed" | "failed"): HpExactGateResult => ({
    status,
    violations: status === "failed" ? ["total_uses"] : [],
    strictImprovement: false,
  });
  return {
    kind: "min-ef-hp-study",
    version: 2,
    generatedAt: "2026-08-28T00:00:00.000Z",
    options: {
      candidates: [candidate("H0.75-p3"), candidate("H1-p3"), candidate("H0.5-p3")],
      scenarioIds: ["s1"],
      exactScenarioIds: ["s1"],
      tolerance: 0,
      minEfMemoTier: 21,
      phase2MemoTier: 22,
      exactSliceBudgetMs: 1,
      supplyForecast: {
        forecastId: "supply-test-v1",
        forecastProfileId: "supply-test-v1@2026-08-28",
        expectedGain: { blue: 1, purple: 1, yellow: 1 },
      },
    },
    measurementProtocol: {},
    decisionPolicy: {},
    decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    baselineVerification: { candidateId: "H0.75-p3", status: "passed", notes: [] },
    screening: { complete: true, records: [], summaries: [], shortlistIds: ["H0.75-p3", "H1-p3"] },
    exact: {
      complete: true,
      records: [],
      gates: [
        { candidateId: "H0.75-p3", scenarioId: "s1", gate: gate("passed") },
        { candidateId: "H1-p3", scenarioId: "s1", gate: gate("failed") },
      ],
      finalistIds: ["H0.75-p3"],
    },
    tailRisk: { status: "pending", records: [] },
    d1Robustness: { status: "pending", records: [] },
    performance: { status: "pending", records: [] },
    candidateGrades: [],
  };
}
