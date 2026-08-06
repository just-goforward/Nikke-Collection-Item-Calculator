import { mkdir, readFile, writeFile } from "node:fs/promises";

import type {
  ExactInteractiveEvaluation,
  ExactInteractiveReplanCheckpoint,
} from "./evaluator/exact-replan-types";
import type { HpCandidate, HpCandidateScreenSummary, HpRootScreenRecord } from "./min-ef-hp-model";
import type { HpLadderTrace } from "./min-ef-hp-policy";
import type { HpExactGateResult } from "./min-ef-hp-quality";

export type HpExactRecord = {
  candidateId: string;
  scenarioId: string;
  evaluation: ExactInteractiveEvaluation;
  ladderOutcomes: Record<string, number>;
};

export type HpStudyReport = {
  kind: "min-ef-hp-study";
  version: 1;
  generatedAt: string;
  options: {
    candidates: HpCandidate[];
    scenarioIds: string[];
    exactScenarioIds: string[];
    tolerance: 0;
    minEfMemoTier: 21;
    phase2MemoTier: 22;
    exactSliceBudgetMs: number;
  };
  measurementProtocol: Record<string, unknown>;
  decisionPolicy: Record<string, unknown>;
  decisionScope: {
    researchOnly: true;
    productAdoptionAuthorized: false;
  };
  baselineVerification: {
    candidateId: string;
    status: "pending" | "passed" | "failed";
    notes: string[];
  };
  screening: {
    complete: boolean;
    records: HpRootScreenRecord[];
    summaries: HpCandidateScreenSummary[];
    shortlistIds: string[];
  };
  exact: {
    complete: boolean;
    records: HpExactRecord[];
    gates: Array<{ candidateId: string; scenarioId: string; gate: HpExactGateResult }>;
    finalistIds: string[];
  };
  tailRisk: { status: "pending" | "completed"; records: unknown[] };
  d1Robustness: { status: "pending" | "completed" | "verification_incomplete"; records: unknown[] };
  performance: { status: "pending" | "completed"; records: unknown[] };
  candidateGrades: Array<{ candidateId: string; grade: string }>;
};

export async function readHpStudyReport(url: URL): Promise<HpStudyReport | null> {
  try {
    const parsed = JSON.parse(await readFile(url, "utf8")) as HpStudyReport;
    if (parsed.kind !== "min-ef-hp-study" || parsed.version !== 1) {
      throw new Error("H/p study report kind or version does not match this runner.");
    }
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function writeHpStudyReport(url: URL, report: HpStudyReport): Promise<void> {
  await mkdir(new URL("./", url), { recursive: true });
  report.generatedAt = new Date().toISOString();
  await writeFile(url, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function readExactCheckpoint(
  url: URL,
): Promise<ExactInteractiveReplanCheckpoint | undefined> {
  try {
    return JSON.parse(await readFile(url, "utf8")) as ExactInteractiveReplanCheckpoint;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function writeExactCheckpoint(
  url: URL,
  checkpoint: ExactInteractiveReplanCheckpoint,
): Promise<void> {
  await mkdir(new URL("./", url), { recursive: true });
  await writeFile(url, `${JSON.stringify(checkpoint)}\n`, "utf8");
}

export function summarizeLadderTraces(traces: readonly HpLadderTrace[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const trace of traces) {
    const key = `${trace.minEfOutcome}->${trace.phase2Outcome}:${trace.selectedBackend ?? "none"}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

export function shouldAdvanceExactEvaluation(
  evaluation: Pick<ExactInteractiveEvaluation, "status"> | undefined,
): boolean {
  return evaluation === undefined || evaluation.status === "verification_incomplete";
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
