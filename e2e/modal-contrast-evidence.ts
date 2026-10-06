import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { TestInfo } from "@playwright/test";
import type { Artifact, DiagnosticContext, Phase, PhaseName } from "./modal-contrast-types";

export function errorText(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "Error value could not be converted to text";
  }
}

function consoleFallback(message: string) {
  try {
    console.warn(message);
  } catch {
    return;
  }
}

export function annotate(context: DiagnosticContext, type: string, description: string) {
  try {
    context.testInfo.annotations.push({ type, description });
  } catch (error) {
    consoleFallback(`modal-contrast annotation failed: ${errorText(error)}; ${description}`);
  }
}

export function recordIssue(context: DiagnosticContext, label: string, error?: unknown) {
  const message = error === undefined ? label : `${label}: ${errorText(error)}`;
  context.errors.push(message);
  // Independent of the filesystem and summary serialization. This happens first.
  annotate(context, "modal-contrast-incomplete", message);
  consoleFallback(`modal-contrast INCOMPLETE: ${message}`);
}

function emptyPhase(): Phase {
  return {
    status: "NOT_STARTED",
    started: 0,
    finished: 0,
    resultObtained: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export function createDiagnosticContext(testInfo: TestInfo): DiagnosticContext {
  return {
    testInfo,
    key: `__nikkeModalContrast_${randomUUID().replaceAll("-", "_")}`,
    metadata: {
      commit: process.env["GITHUB_SHA"] ?? null,
      testId: testInfo.testId,
      title: testInfo.title,
      retry: testInfo.retry,
      repeatEachIndex: testInfo.repeatEachIndex,
      workerIndex: testInfo.workerIndex,
      configuredRetries: testInfo.project.retries,
      project: testInfo.project.name,
      hostTimeOrigin: performance.timeOrigin,
      timingBoundary: "Public analyze() and snapshot RPC boundaries, not per-node axe sampling",
      observerEffect:
        "Unique window registry/functions, RPCs, style/layout reads, persistence and assertions consume time",
      documentBoundary:
        "Installed after goto before any clicks; used only in that document, page, test and retry",
      mutation:
        "Adds a unique window registry holding functions and its Document reference; no CSS/style mutation",
      settlementBoundary:
        "2 seconds while the browser event loop responds; 3 matching rAF frames and 250ms",
      incompleteScope: "Any initial or stable axe incomplete rule is a diagnostic measurement gap",
    },
    errors: [],
    artifacts: [],
    phases: {
      installation: emptyPhase(),
      initialBefore: emptyPhase(),
      initialAxe: emptyPhase(),
      initialAfter: emptyPhase(),
      settlement: emptyPhase(),
      stableBefore: emptyPhase(),
      stableAxe: emptyPhase(),
      stableAfter: emptyPhase(),
    },
    initial: null,
    stable: null,
    initialRawSaved: false,
    stableRawSaved: false,
    stableEndpointsUnchanged: null,
  };
}

export function startPhase(context: DiagnosticContext, name: PhaseName) {
  const phase = context.phases[name];
  phase.started++;
  phase.startedAt = performance.now();
  phase.status = "RUNNING";
  annotate(context, "modal-contrast-phase", `${name}: started; retry=${context.testInfo.retry}`);
}

export function finishPhase(context: DiagnosticContext, name: PhaseName) {
  const phase = context.phases[name];
  phase.finished++;
  phase.resultObtained++;
  phase.finishedAt = performance.now();
  phase.status = "COMPLETE";
}

export function failPhase(context: DiagnosticContext, name: PhaseName, error: unknown) {
  const phase = context.phases[name];
  phase.finished++;
  phase.finishedAt = performance.now();
  phase.status = "ERROR";
  phase.error = errorText(error);
  recordIssue(context, name, error);
}

export async function collectPhase<T>(
  context: DiagnosticContext,
  name: PhaseName,
  collect: () => Promise<T>,
): Promise<T | null> {
  startPhase(context, name);
  try {
    const result = await collect();
    finishPhase(context, name);
    return result;
  } catch (error) {
    failPhase(context, name, error);
    return null;
  }
}

export function saveEvidence(context: DiagnosticContext, name: string, data: unknown) {
  try {
    const path = context.testInfo.outputPath(`modal-contrast-${name}.json`);
    writeFileSync(path, `${JSON.stringify({ metadata: context.metadata, data }, null, 2)}\n`, {
      flag: "wx",
    });
    const artifact = { name, path, attached: false };
    context.artifacts.push(artifact);
    return artifact;
  } catch (error) {
    recordIssue(context, `save ${name}`, error);
    return null;
  }
}

export async function attachEvidence(context: DiagnosticContext, artifact: Artifact) {
  try {
    await context.testInfo.attach(`modal-contrast-${artifact.name}.json`, {
      path: artifact.path,
      contentType: "application/json",
    });
    artifact.attached = true;
  } catch (error) {
    recordIssue(context, `attach ${artifact.name}`, error);
  }
}
