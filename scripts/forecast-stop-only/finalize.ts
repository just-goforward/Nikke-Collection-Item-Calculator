import { parseRegistry, reason, sameRegistry } from "./registry.ts";
import { type Api, type Registry, roles, type Snapshot, type WorkerResult } from "./types.ts";

export async function finalize(api: Api, snapshot: Snapshot | undefined, results: WorkerResult[]) {
  const registries = results.flatMap((r) => (r.registry ? [r.registry] : []));
  const expected = snapshot?.registry ?? registries[0];
  const { registryStable, registryReason } = await observeRegistry(api, expected, registries);
  const budgetStop = snapshot?.budgetStop === true || results.some((r) => r.purpose === "budget");
  const integrityReasons = integrityIssues(snapshot, results, registries, expected);
  const fail = !registryStable || !validResults(results) || integrityReasons.size > 0;
  const continuity =
    results.length === 2 &&
    results.every(
      (r) =>
        r.historyTrusted === true &&
        !r.priorUnresolved &&
        r.epochComparison === "compared" &&
        r.currentVerified,
    );
  return {
    results,
    registryStable,
    registryReason,
    budgetStop,
    epochComparison: snapshot?.epochComparison ?? "unavailable",
    priorRequestEvidence: snapshot?.priorRequestEvidence ?? {
      collector: "missing",
      dispatcher: "missing",
    },
    integrityReasons: [...integrityReasons],
    fail,
    alert: fail,
    nextStageAllowed: !fail && !budgetStop && continuity,
  };
}
async function observeRegistry(api: Api, expected: Registry | undefined, registries: Registry[]) {
  let registryStable = false,
    registryReason = "registry_unavailable";
  try {
    const after = await api.registry();
    if (expected) {
      const parsed = parseRegistry(after, expected.accountId);
      registryStable =
        sameRegistry(expected, parsed) && registries.every((r) => sameRegistry(r, parsed));
      registryReason = registryStable ? "unchanged" : "registry_changed";
    }
  } catch (error) {
    registryReason = reason(error);
  }
  return { registryStable, registryReason };
}
function integrityIssues(
  snapshot: Snapshot | undefined,
  results: WorkerResult[],
  registries: Registry[],
  expected: Registry | undefined,
) {
  const epochs = new Set(registries.map((r) => r.epoch));
  const integrityReasons = new Set<string>();
  if (epochs.size > 1) integrityReasons.add("registry_epoch_split");
  else if (registries.some((r) => expected && !sameRegistry(r, expected)))
    integrityReasons.add("registry_pair_split");
  if (!snapshot || snapshot.snapshotMissing || results.some((r) => r.snapshotMissing))
    integrityReasons.add("pair_snapshot_missing");
  if (snapshot?.epochIssue) integrityReasons.add(snapshot.epochIssue);
  for (const r of results) {
    if (r.purpose !== "budget") continue;
    for (const diagnostic of r.diagnostics ?? []) integrityReasons.add(diagnostic);
    if (r.epochComparison !== "compared") integrityReasons.add("epoch_baseline_unavailable");
  }
  return integrityReasons;
}
function validResults(results: WorkerResult[]) {
  return (
    results.length === 2 &&
    roles.every((role) =>
      results.some((r) => r.role === role && ["idle", "verified"].includes(r.state)),
    )
  );
}
