import { inspectJournal } from "./evidence.ts";
import { finalize } from "./finalize.ts";
import { checkVersion, currentMatches, epochCheck, parseRegistry, reason } from "./registry.ts";
import { submit } from "./requests.ts";

import {
  type Api,
  type Journal,
  type Registry,
  type Role,
  roles,
  type Snapshot,
  type WorkerResult,
} from "./types.ts";

export async function prepare(
  api: Api,
  accountId: string,
  budgetStop: boolean,
  baseline?: number,
  targets: readonly Role[] = roles,
): Promise<Snapshot> {
  const snapshot: Snapshot = { errors: {}, epochComparison: "unavailable", budgetStop };
  if (baseline !== undefined) snapshot.epochBaseline = baseline;
  try {
    const registry = parseRegistry(await api.registry(), accountId);
    snapshot.registry = registry;
    try {
      snapshot.epochComparison = epochCheck(registry.epoch, baseline);
    } catch (error) {
      snapshot.epochIssue = reason(error);
    }
    for (const role of targets) {
      try {
        await checkVersion(api, registry, role);
      } catch (error) {
        snapshot.errors[role] = reason(error);
      }
    }
  } catch (error) {
    for (const role of roles) snapshot.errors[role] = reason(error);
  }
  return snapshot;
}

export async function stopWorker(
  api: Api,
  journal: Journal,
  snapshot: Snapshot,
  role: Role,
): Promise<WorkerResult> {
  const base: WorkerResult = {
    role,
    state: "failed",
    requestResolved: false,
    currentVerified: false,
    evidence: "not_requested",
    reason: snapshot.errors[role] ?? "registry_unavailable",
    purpose: snapshot.budgetStop ? "budget" : "readonly",
  };
  const registry = snapshot.registry;
  if (!registry) return base;
  const context = {
    registry,
    epochComparison: snapshot.epochComparison,
    snapshotMissing: snapshot.snapshotMissing ?? false,
  };
  if (snapshot.errors[role])
    return {
      ...base,
      ...context,
      historyTrusted: false,
      purpose: snapshot.budgetStop ? "budget" : "readonly",
    };
  const required = requiredObservation(snapshot);
  const observation: WorkerObservation =
    required === "current" ? await observeCurrent(api, registry, role) : { kind: required };
  const evidence = await inspectJournal(journal);
  const diagnostics = journalDiagnostics(snapshot, evidence);
  const action = decideWorkerAction(snapshot, evidence, observation);
  if (action.kind === "readonly")
    return { ...base, ...action.result, ...context, ...evidence, diagnostics, purpose: "readonly" };
  if (action.kind === "block")
    return {
      ...base,
      ...context,
      ...evidence,
      diagnostics,
      purpose: "hold",
      state: "unknown",
      reason: action.reason,
    };
  if (!evidence.historyTrusted) await markIncomplete(journal, diagnostics);
  const result = await submit(api, journal, registry, role, {
    origin: "watchdog",
    purpose: action.purpose,
  });
  return annotatedResult(result, snapshot, journal, evidence, diagnostics);
}

type JournalEvidence = Awaited<ReturnType<typeof inspectJournal>>;
type WorkerObservation =
  | { kind: "budget" | "idle" | "match" | "mismatch" }
  | { kind: "unavailable"; reason: string };
type WorkerDecision =
  | {
      kind: "readonly";
      result: Pick<WorkerResult, "state" | "reason"> & { currentVerified?: true };
    }
  | { kind: "block"; reason: string }
  | { kind: "submit"; purpose: "budget" | "hold" };

function requiredObservation(snapshot: Snapshot): "budget" | "idle" | "current" {
  if (snapshot.budgetStop) return "budget";
  return snapshot.registry?.maintenanceHold ? "current" : "idle";
}
function decideWorkerAction(
  snapshot: Snapshot,
  evidence: JournalEvidence,
  observation: WorkerObservation,
): WorkerDecision {
  switch (observation.kind) {
    case "budget":
      return { kind: "submit", purpose: "budget" };
    case "idle":
      return { kind: "readonly", result: { state: "idle", reason: "no_stop_requested" } };
    case "match":
      return {
        kind: "readonly",
        result: { state: "verified", reason: "registered_version_observed", currentVerified: true },
      };
    case "unavailable":
      return { kind: "readonly", result: { state: "unknown", reason: observation.reason } };
    case "mismatch":
      return correctionAllowed(snapshot, evidence)
        ? { kind: "submit", purpose: "hold" }
        : {
            kind: "block",
            reason: evidence.priorUnresolved
              ? "previous_request_unresolved"
              : "correction_evidence_unavailable",
          };
  }
}
function journalDiagnostics(snapshot: Snapshot, evidence: JournalEvidence) {
  return [
    ...evidence.diagnostics,
    ...(snapshot.epochIssue ? [snapshot.epochIssue] : []),
    ...(evidence.priorUnresolved ? ["previous_request_unresolved"] : []),
    ...(snapshot.snapshotMissing ? ["pair_snapshot_missing"] : []),
  ];
}
function correctionAllowed(snapshot: Snapshot, evidence: JournalEvidence) {
  try {
    return (
      evidence.historyTrusted &&
      !evidence.priorUnresolved &&
      !snapshot.epochIssue &&
      snapshot.epochComparison === "compared" &&
      snapshot.registry !== undefined &&
      epochCheck(snapshot.registry.epoch, snapshot.epochBaseline) === "compared"
    );
  } catch {
    return false;
  }
}
async function markIncomplete(journal: Journal, diagnostics: string[]) {
  try {
    await journal.markIncomplete("baseline_incomplete");
  } catch {
    diagnostics.push("incomplete_marker_failed");
  }
}
function annotatedResult(
  result: WorkerResult,
  snapshot: Snapshot,
  journal: Journal,
  evidence: JournalEvidence,
  diagnostics: string[],
) {
  const historyTrusted = evidence.historyTrusted && journal.baselineEvidence === "provided";
  if (!historyTrusted && !diagnostics.includes("request_history_incomplete"))
    diagnostics.push("request_history_incomplete");
  if (!snapshot.budgetStop) {
    // Correction under maintenanceHold is NEW deployment authority. Activation
    // needs explicit approval; no scheduler interval is a recovery-time bound.
    result.corrected = result.currentVerified;
    if (result.state === "verified") {
      result.state = "failed";
      result.reason = "maintenance_version_mismatch";
    }
  }
  return {
    ...result,
    ...evidence,
    historyTrusted,
    diagnostics,
    registry: snapshot.registry,
    epochComparison: snapshot.epochComparison,
    snapshotMissing: snapshot.snapshotMissing ?? false,
    purpose: snapshot.budgetStop ? ("budget" as const) : ("hold" as const),
  };
}

async function observeCurrent(
  api: Api,
  registry: Registry,
  role: Role,
): Promise<WorkerObservation> {
  try {
    return { kind: (await currentMatches(api, registry, role)) ? "match" : "mismatch" };
  } catch (error) {
    return { kind: "unavailable", reason: reason(error) };
  }
}

// Test-only in-memory orchestration model; not an oracle for actual workflow protection conditions.
export async function runWatchdog(
  api: Api,
  journals: Record<Role, Journal>,
  accountId: string,
  budgetStop: boolean,
  protect: { production(): Promise<void>; alert(): Promise<void>; fail(): Promise<void> },
  baseline?: number,
) {
  const snapshot = await prepare(api, accountId, budgetStop, baseline);
  const results: WorkerResult[] = [];
  for (const role of roles) results.push(await stopWorker(api, journals[role], snapshot, role));
  const report = await finalize(api, snapshot, results);
  // The workflow applies its ORIGINAL emergency condition separately. A stop
  // failure must not prevent production protection, alerts, or failure reporting.
  const protectionResults = await Promise.allSettled([
    protect.production(),
    ...(report.alert ? [protect.alert()] : []),
    ...(report.fail ? [protect.fail()] : []),
  ]);
  return { ...report, protectionResults: protectionResults.map((r) => r.status) };
}
