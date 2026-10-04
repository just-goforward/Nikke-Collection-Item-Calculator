import { randomUUID } from "node:crypto";
import { checkVersion, currentMatches, matches, reason } from "./registry.ts";
import type {
  Api,
  Attempt,
  Journal,
  Receipt,
  Registry,
  Role,
  SubmissionAuthority,
  WorkerResult,
} from "./types.ts";

export function newAttempt(registry: Registry, role: Role, kind: "watchdog" | "operator"): Attempt {
  const requestId = randomUUID();
  const message = `forecast-stop/v1:${requestId};epoch=${registry.epoch};role=${role};kind=${kind}`;
  if (Buffer.byteLength(message, "utf8") > 1000) throw new Error("deployment_message_too_long");
  return {
    requestId,
    role,
    script: registry.workers[role].script,
    versionId: registry.workers[role].versionId,
    epoch: registry.epoch,
    startedAt: new Date().toISOString(),
    approvalRef: registry.approvalRef,
    message,
  };
}

export async function unresolved(journal: Journal) {
  const latest = new Map<string, Receipt>();
  for (const receipt of await journal.read()) latest.set(receipt.attempt.requestId, receipt);
  return [...latest.values()].some((r) => !["resolved", "not_submitted"].includes(r.state));
}

export async function submit(
  api: Api,
  journal: Journal,
  registry: Registry,
  role: Role,
  authority: SubmissionAuthority,
  prepared?: Attempt,
): Promise<WorkerResult> {
  const kind = authority.origin;
  const attempt = prepared ?? newAttempt(registry, role, kind);
  const result: WorkerResult = {
    role,
    state: "unknown",
    requestResolved: false,
    currentVerified: false,
    evidence: "missing",
    reason: "request_unknown",
    requestId: attempt.requestId,
  };
  try {
    await checkVersion(api, registry, role);
  } catch (error) {
    return { ...result, state: "failed", reason: reason(error) };
  }
  // Origin (watchdog) is distinct from authority (an actual budget stop).
  const persisted = await persistAttempt(journal, attempt, prepared !== undefined);
  if (!persisted) {
    try {
      await journal.markIncomplete("request_write_failed");
    } catch {
      result.evidence = "missing";
    }
    if (authority.origin !== "watchdog" || authority.purpose !== "budget")
      return { ...result, state: "failed", reason: "request_evidence_missing" };
  }
  let acceptedId: string | undefined;
  try {
    acceptedId = (await api.deploy(registry, role, attempt.message)).id;
  } catch {
    result.reason = "submission_unacknowledged";
  }
  return observeRequest(api, journal, registry, attempt, result, acceptedId);
}

async function persistAttempt(journal: Journal, attempt: Attempt, prepared: boolean) {
  try {
    if (!prepared) await journal.append({ attempt, state: "prepared" });
    await journal.append({ attempt, state: "submitted" });
    return true;
  } catch {
    return false;
  }
}

function observationReason(logged: boolean, known: boolean, current: boolean) {
  if (!logged) return "request_evidence_missing";
  if (!known) return "request_unknown";
  if (!current) return "current_version_mismatch";
  return "registered_version_observed";
}

async function observeRequest(
  api: Api,
  journal: Journal,
  registry: Registry,
  attempt: Attempt,
  result: WorkerResult,
  acceptedId?: string,
) {
  const role = attempt.role;
  let known = false,
    logged = false;
  let identified: string | undefined;
  try {
    const entries = await api.history(registry, role);
    const attributed = entries.filter(
      (d) => d.message === attempt.message && matches(d, registry, role),
    );
    known =
      attributed.length === 1 && (acceptedId === undefined || attributed[0]?.id === acceptedId);
    identified = attributed.length === 1 ? attributed[0]?.id : undefined;
  } catch {
    known = false;
  }
  try {
    logged = (await journal.read()).some(
      (r) =>
        r.attempt.requestId === attempt.requestId &&
        r.state === "submitted" &&
        JSON.stringify(r.attempt) === JSON.stringify(attempt),
    );
  } catch {
    logged = false;
  }
  result.evidence = logged ? "preserved" : "missing";
  result.requestResolved = known && logged;
  try {
    result.currentVerified = await currentMatches(api, registry, role);
  } catch {
    result.currentVerified = false;
  }
  result.state = result.requestResolved
    ? result.currentVerified
      ? "verified"
      : "failed"
    : "unknown";
  result.reason = observationReason(logged, known, result.currentVerified);
  try {
    await journal.append({
      attempt,
      state: result.requestResolved ? "resolved" : "unknown",
      ...(identified ? { deploymentId: identified } : {}),
    });
  } catch (error) {
    result.state = "unknown";
    result.reason = reason(error);
    try {
      await journal.markIncomplete("request_write_failed");
    } catch {
      result.evidence = "missing";
    }
  }
  return result;
}

export async function resolvePending(api: Api, journal: Journal, registry: Registry) {
  const latest = new Map<string, Receipt>();
  for (const receipt of await journal.read()) latest.set(receipt.attempt.requestId, receipt);
  for (const receipt of latest.values()) {
    if (["resolved", "not_submitted"].includes(receipt.state)) continue;
    const { attempt } = receipt;
    if (
      attempt.epoch !== registry.epoch ||
      attempt.script !== registry.workers[attempt.role].script ||
      attempt.versionId !== registry.workers[attempt.role].versionId
    )
      continue;
    const found = (await api.history(registry, attempt.role)).filter(
      (d) => d.message === attempt.message && matches(d, registry, attempt.role),
    );
    const identified = found[0];
    if (found.length === 1 && identified && receipt.state !== "prepared")
      await journal.append({ attempt, state: "resolved", deploymentId: identified.id });
  }
  return unresolved(journal);
}
