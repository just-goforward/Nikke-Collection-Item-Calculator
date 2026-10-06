import { annotate, attachEvidence, recordIssue, saveEvidence } from "./modal-contrast-evidence";
import type { AxeResult, DiagnosticContext, Sample } from "./modal-contrast-types";

export function hasAxeResult(result: unknown): result is AxeResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "violations" in result &&
    Array.isArray(result.violations)
  );
}

export function recordAxeGaps(context: DiagnosticContext, phase: string, result: AxeResult) {
  if (!Array.isArray(result.incomplete)) {
    recordIssue(context, `${phase}: missing axe incomplete results`);
  } else if (result.incomplete.length > 0) {
    recordIssue(context, `${phase}: ${result.incomplete.length} axe incomplete rules`);
  }
  if (!Array.isArray(result.passes)) recordIssue(context, `${phase}: missing axe pass results`);
}

export function recordSampleGaps(context: DiagnosticContext, name: string, sample: Sample) {
  if (!sample.snapshot.targetsComplete) recordIssue(context, `${name}: target coverage incomplete`);
  if (sample.snapshot.fonts.checks.some((check) => check.available === null)) {
    recordIssue(context, `${name}: font measurements missing or failed`);
  }
}

function missingEvidence(context: DiagnosticContext) {
  const missing = Object.entries(context.phases)
    .filter(([, phase]) => phase.status !== "COMPLETE")
    .map(([name, phase]) => `${name}:${phase.status}`);
  if (!context.initialRawSaved) missing.push("initial raw not saved");
  if (!context.stableRawSaved) missing.push("stable raw not saved");
  if (context.stableEndpointsUnchanged !== true) missing.push("stable endpoints unconfirmed");
  return missing;
}

function ruleCount(result: AxeResult | null, kind: "violations" | "incomplete") {
  if (!result || !Array.isArray(result[kind])) return null;
  return result[kind].length;
}

function diagnosticSummary(context: DiagnosticContext, stage: "provisional" | "final") {
  const initialViolationRules = ruleCount(context.initial, "violations");
  const stableViolationRules = ruleCount(context.stable, "violations");
  const initialFailure = initialViolationRules === null ? null : initialViolationRules > 0;
  const stableFailure = stableViolationRules === null ? null : stableViolationRules > 0;
  const missing = missingEvidence(context);
  const collectionIncomplete =
    stage === "provisional" || context.errors.length > 0 || missing.length > 0;
  const knownViolation = initialFailure === true || stableFailure === true;
  const verdict = knownViolation
    ? "UNRESOLVED"
    : collectionIncomplete
      ? "INCOMPLETE"
      : "NOT_REPRODUCED";
  return {
    stage,
    verdict,
    initialFailure,
    stableFailure,
    collectionIncomplete,
    initialViolationRules,
    stableViolationRules,
    initialIncompleteRules: ruleCount(context.initial, "incomplete"),
    stableIncompleteRules: ruleCount(context.stable, "incomplete"),
    phases: context.phases,
    missing,
    errors: [...context.errors],
    artifacts: context.artifacts.map(({ name, attached }) => ({ name, attached })),
    initialCriterion: "Original full WCAG tags, initial violations equal []",
    stableResultsAreDiagnosticOnly: true,
    intervalBoundary: "Matching endpoints do not prove the entire axe interval was stable",
    phaseCounterMeaning:
      "started=invoked, finished=fulfilled/rejected, resultObtained=valid returned result",
  };
}

export function checkpoint(context: DiagnosticContext, name: string) {
  saveEvidence(context, name, diagnosticSummary(context, "provisional"));
}

export async function finishDiagnosticReport(context: DiagnosticContext) {
  try {
    // Attachment failures are collected before computing the final verdict.
    for (const artifact of [...context.artifacts]) await attachEvidence(context, artifact);
    // The authoritative summary is written last and collected from outputPath by
    // CI. It is not attached again, so no pending attachment can invalidate it.
    saveEvidence(context, "06-summary", diagnosticSummary(context, "final"));
  } catch (error) {
    recordIssue(context, "final reporting", error);
  }
  const result = diagnosticSummary(context, "final");
  annotate(
    context,
    "modal-contrast-verdict",
    `${result.verdict}; initialFailure=${result.initialFailure}; collectionIncomplete=${result.collectionIncomplete}`,
  );
}
