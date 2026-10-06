import type { Page, TestInfo } from "@playwright/test";
import { installModalReaders, sampleModal } from "./modal-contrast-browser";
import {
  collectPhase,
  createDiagnosticContext,
  errorText,
  failPhase,
  finishPhase,
  recordIssue,
  saveEvidence,
  startPhase,
} from "./modal-contrast-evidence";
import {
  checkpoint,
  finishDiagnosticReport,
  hasAxeResult,
  recordAxeGaps,
  recordSampleGaps,
} from "./modal-contrast-report";
import type { AxeResult, DiagnosticContext, PhaseName, Sample } from "./modal-contrast-types";

export async function prepareModalContrast(page: Page, testInfo: TestInfo) {
  const context = createDiagnosticContext(testInfo);
  context.metadata["registryKey"] = context.key;
  const installation = await collectPhase(context, "installation", async () => {
    context.metadata["browserVersion"] = page.context().browser()?.version() ?? null;
    return installModalReaders(page, context.key);
  });
  context.metadata["installation"] = installation;
  return context;
}

async function captureSample(
  page: Page,
  context: DiagnosticContext,
  name: PhaseName,
  settle = false,
) {
  return collectPhase(context, name, async () => {
    const sample = await sampleModal(page, context.key, settle);
    recordSampleGaps(context, name, sample);
    return sample;
  });
}

async function initialAnalysis(
  context: DiagnosticContext,
  analyze: () => Promise<AxeResult>,
  before: Sample | null,
) {
  startPhase(context, "initialAxe");
  let initial: AxeResult;
  try {
    const pending = analyze();
    saveEvidence(context, "00-initial-start", { before, phase: context.phases.initialAxe });
    initial = await pending;
  } catch (error) {
    failPhase(context, "initialAxe", error);
    saveEvidence(context, "00-initial-error", {
      before,
      phase: context.phases.initialAxe,
      error: errorText(error),
    });
    checkpoint(context, "00-initial-error-summary");
    // Do not wrap the product analysis error, including non-Error rejections.
    throw error;
  }
  if (!hasAxeResult(initial)) {
    const error = new Error("Initial axe analysis returned no usable result");
    failPhase(context, "initialAxe", error);
    context.phases.initialAxe.status = "MISSING";
    saveEvidence(context, "00-initial-missing", { before, phase: context.phases.initialAxe });
    checkpoint(context, "00-initial-error-summary");
    throw error;
  }
  finishPhase(context, "initialAxe");
  context.initial = initial;
  return initial;
}

async function stableAnalysis(
  page: Page,
  context: DiagnosticContext,
  analyze: () => Promise<AxeResult>,
  before: Sample,
) {
  startPhase(context, "stableAxe");
  try {
    const pending = analyze();
    saveEvidence(context, "03-stable-start", { before, phase: context.phases.stableAxe });
    checkpoint(context, "03-stable-pending-summary");
    const stable = await pending;
    if (!hasAxeResult(stable)) throw new Error("Stable axe analysis returned no usable result");
    finishPhase(context, "stableAxe");
    context.stable = stable;
  } catch (error) {
    failPhase(context, "stableAxe", error);
    saveEvidence(context, "04-stable-error", {
      phase: context.phases.stableAxe,
      error: errorText(error),
    });
    return;
  }
  context.stableRawSaved =
    saveEvidence(context, "04-stable", {
      before,
      phase: context.phases.stableAxe,
      result: context.stable,
    }) !== null;
  recordAxeGaps(context, "stableAxe", context.stable);
  const after = await captureSample(page, context, "stableAfter");
  context.stableEndpointsUnchanged = after?.ready === true && after.signature === before.signature;
  saveEvidence(context, "05-stable-after", {
    sample: after,
    endpointsUnchanged: context.stableEndpointsUnchanged,
    boundary: "Matching endpoints do not prove the entire axe interval was stable",
  });
  if (!context.stableEndpointsUnchanged) recordIssue(context, "STABLE_WINDOW_CHANGED");
}

async function collectAfterInitial(
  page: Page,
  context: DiagnosticContext,
  analyze: () => Promise<AxeResult>,
) {
  // The original 30s deadline stays in force through initial analysis/assertion/raw save.
  context.testInfo.setTimeout(45_000);
  const after = await captureSample(page, context, "initialAfter");
  saveEvidence(context, "01-initial-after", { sample: after, phase: context.phases.initialAfter });
  const settlement = await captureSample(page, context, "settlement", true);
  saveEvidence(context, "02-settlement", { settlement, phase: context.phases.settlement });
  if (settlement?.state !== "SETTLED") {
    recordIssue(context, "NOT_SETTLED: stable axe was not started");
    return;
  }
  const before = await captureSample(page, context, "stableBefore");
  if (!before?.ready || before.signature !== settlement.signature) {
    recordIssue(context, "LOST_SETTLEMENT: stable axe was not started");
    saveEvidence(context, "03-lost-settlement", { sample: before });
    return;
  }
  await stableAnalysis(page, context, analyze, before);
}

export async function diagnoseModalContrast(
  page: Page,
  context: DiagnosticContext,
  analyze: () => Promise<AxeResult>,
  clickCompletedAt: number,
  recordInitialAssertion: (result: AxeResult) => void,
) {
  context.metadata["clickCompletedAt"] = clickCompletedAt;
  const before = await captureSample(page, context, "initialBefore");
  const initial = await initialAnalysis(context, analyze, before);
  // No diagnostic await or serialization between receiving valid raw and soft assertion.
  // Assertion exceptions remain product failures, outside the diagnostic catch below.
  recordInitialAssertion(initial);
  try {
    context.initialRawSaved =
      saveEvidence(context, "00-initial", {
        before,
        phase: context.phases.initialAxe,
        result: initial,
      }) !== null;
    recordAxeGaps(context, "initialAxe", initial);
    checkpoint(context, "00-provisional-summary");
    await collectAfterInitial(page, context, analyze);
  } catch (error) {
    recordIssue(context, "post-initial collection", error);
  }
  await finishDiagnosticReport(context);
  return { initial, stable: context.stable };
}
