import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { HP_BASELINE_ID } from "./min-ef-hp-model";
import { type HpStudyReport, writeHpStudyReport } from "./min-ef-hp-report";

it("does not rewrite an unchanged H/p report or churn its generated timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hp-study-report-"));
  const url = pathToFileURL(join(directory, "report.json"));
  const report = {
    kind: "min-ef-hp-study",
    version: 1,
    generatedAt: "initial",
    options: {
      candidates: [],
      scenarioIds: [],
      exactScenarioIds: [],
      tolerance: 0,
      minEfMemoTier: 21,
      phase2MemoTier: 22,
      exactSliceBudgetMs: 1,
    },
    measurementProtocol: {},
    decisionPolicy: {},
    decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    baselineVerification: { candidateId: HP_BASELINE_ID, status: "pending", notes: [] },
    screening: { complete: false, records: [], summaries: [], shortlistIds: [] },
    exact: { complete: false, records: [], gates: [], finalistIds: [] },
    tailRisk: { status: "pending", records: [] },
    d1Robustness: { status: "pending", records: [] },
    performance: { status: "pending", records: [] },
    candidateGrades: [],
  } satisfies HpStudyReport;
  try {
    await writeHpStudyReport(url, report);
    const firstTimestamp = report.generatedAt;
    const firstBytes = await readFile(url, "utf8");
    await writeHpStudyReport(url, structuredClone(report));
    const secondBytes = await readFile(url, "utf8");

    expect(JSON.parse(secondBytes).generatedAt).toBe(firstTimestamp);
    expect(secondBytes).toBe(firstBytes);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
