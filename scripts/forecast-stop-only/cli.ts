import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { writeAtomicJson } from "./atomic.ts";
import { copyBaselines, epochBaseline } from "./evidence.ts";
import { finalize } from "./finalize.ts";
import { fileJournal } from "./journal.ts";
import { operatorStop } from "./operator.ts";
import { parseRegistry } from "./registry.ts";
import { resultSchema, role } from "./schemas.ts";
import { type Api, type Role, roles, type Snapshot, type WorkerResult } from "./types.ts";
import { prepare, stopWorker } from "./watchdog.ts";
import { loadSnapshot, workerContext } from "./worker-context.ts";

const output = (packet: string, name: string, value: unknown) =>
  writeFileSync(`${packet}/${name}.json`, JSON.stringify(value, null, 2) + "\n");
export async function executeMode(
  mode: string | undefined,
  packet: string,
  roleValue: string | undefined,
  api: Api,
  accountId: string,
  vars: NodeJS.ProcessEnv,
) {
  if (mode === "prepare") return preparePacket(api, accountId, packet, vars);
  if (mode === "worker" || mode === "operator") {
    const target = role.parse(roleValue);
    if (mode === "operator") return operatorPacket(api, accountId, packet, target, vars);
    return workerPacket(api, accountId, packet, target, vars);
  }
  let snapshot: Snapshot | undefined;
  try {
    snapshot = loadSnapshot(packet, accountId);
  } catch {
    snapshot = {
      errors: { collector: "pair_snapshot_invalid", dispatcher: "pair_snapshot_invalid" },
      epochComparison: "unavailable",
      epochIssue: "pair_snapshot_invalid",
      budgetStop: false,
    };
  }
  const results = roles.map((target) => loadResult(packet, accountId, target));
  const report = await finalize(api, snapshot, results);
  output(packet, "aggregate", report);
  if (vars["GITHUB_OUTPUT"])
    appendFileSync(vars["GITHUB_OUTPUT"], `fail=${report.fail}\nalert=${report.alert}\n`);
}

async function preparePacket(api: Api, accountId: string, packet: string, vars: NodeJS.ProcessEnv) {
  const copied = await copyBaselines(packet, vars["FORECAST_STOP_REQUEST_BASELINE_DIR"]);
  const epoch = epochBaseline(vars["FORECAST_STOP_EPOCH_BASELINE_FILE"]);
  const snapshot = await prepare(api, accountId, vars["BUDGET_STOP"] === "true", epoch.baseline);
  if (epoch.issue) snapshot.epochIssue = epoch.issue;
  snapshot.priorRequestEvidence = copied.states;
  snapshot.evidenceIssues = copied.issues;
  // Recoverable account/registry/version/baseline errors are captured above.
  // Process death and a failed file write cannot guarantee this snapshot.
  writeAtomicJson(`${packet}/snapshot.json`, snapshot);
}
async function workerPacket(
  api: Api,
  accountId: string,
  packet: string,
  target: Role,
  vars: NodeJS.ProcessEnv,
) {
  const { snapshot, issue } = await workerContext(
    api,
    packet,
    accountId,
    target,
    vars["BUDGET_STOP"] === "true",
  );
  if (!snapshot) {
    output(packet, target, {
      ...missingResult(target),
      reason: issue,
      snapshotMissing: issue === "pair_snapshot_missing",
      diagnostics: [issue],
    });
    process.exitCode = 1;
    return;
  }
  const trusted =
    snapshot.priorRequestEvidence?.[target] === "provided" && !snapshot.snapshotMissing;
  // Fallback evidence cannot append to or inherit an unbound prepared chain.
  const filename = snapshot.snapshotMissing ? `${target}-fallback-requests` : `${target}-requests`;
  const journal = fileJournal(`${packet}/${filename}.jsonl`, trusted ? "provided" : "unavailable");
  const result = await stopWorker(api, journal, snapshot, target);
  output(packet, target, {
    ...result,
    snapshotMissing: snapshot.snapshotMissing ?? false,
    diagnostics: [...(result.diagnostics ?? []), ...(snapshot.fallbackDiagnostics ?? [])],
  });
  if (!["verified", "idle"].includes(result.state)) process.exitCode = 1;
}
async function operatorPacket(
  api: Api,
  accountId: string,
  packet: string,
  target: Role,
  vars: NodeJS.ProcessEnv,
) {
  const snapshot = loadSnapshot(packet, accountId),
    epoch = epochBaseline(vars["FORECAST_STOP_EPOCH_BASELINE_FILE"]);
  if (snapshot?.epochComparison !== "compared" || snapshot.epochIssue || epoch.issue) {
    output(packet, target, {
      fail: true,
      alert: true,
      nextStageAllowed: false,
      reason: "operator_evidence_unavailable",
    });
    process.exitCode = 1;
    return;
  }
  const journal = fileJournal(
    `${packet}/${target}-requests.jsonl`,
    snapshot.priorRequestEvidence?.[target] === "provided" ? "provided" : "unavailable",
  );
  const report = await operatorStop(
    api,
    journal,
    accountId,
    target,
    epoch.baseline ?? snapshot.epochBaseline,
  );
  output(packet, target, report);
  if (report.fail) process.exitCode = 1;
}
function missingResult(target: Role): WorkerResult {
  return {
    role: target,
    state: "unknown",
    requestResolved: false,
    currentVerified: false,
    evidence: "missing",
    reason: "pair_snapshot_missing",
    snapshotMissing: true,
    historyTrusted: false,
    purpose: "readonly",
    diagnostics: ["pair_snapshot_missing"],
  };
}
function loadResult(packet: string, accountId: string, target: Role): WorkerResult {
  try {
    const parsed = resultSchema.parse(JSON.parse(readFileSync(`${packet}/${target}.json`, "utf8")));
    if (parsed.role !== target) throw Error("worker_role_mismatch");
    const { registry, ...rest } = parsed;
    return { ...rest, ...(registry ? { registry: parseRegistry(registry, accountId) } : {}) };
  } catch {
    return { ...missingResult(target), reason: "worker_result_missing" };
  }
}
