import { existsSync, readFileSync } from "node:fs";
import { fileJournal } from "./journal.ts";
import { retryableRead } from "./read-errors.ts";
import { epochCheck, parseRegistry } from "./registry.ts";
import { snapshotSchema } from "./schemas.ts";
import type { Api, Role, Snapshot } from "./types.ts";
import { prepare } from "./watchdog.ts";

export function loadSnapshot(packet: string, accountId: string): Snapshot | undefined {
  try {
    const raw = snapshotSchema.parse(JSON.parse(readFileSync(`${packet}/snapshot.json`, "utf8")));
    const registry =
      raw.registry === undefined ? undefined : parseRegistry(raw.registry, accountId);
    if (
      raw.epochComparison === "compared" &&
      (!registry || epochCheck(registry.epoch, raw.epochBaseline) !== "compared")
    )
      throw new Error("pair_snapshot_invalid");
    return {
      ...raw,
      ...(registry === undefined ? {} : { registry }),
    } as Snapshot;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("pair_snapshot_invalid");
  }
}
export async function workerContext(
  api: Api,
  packet: string,
  accountId: string,
  role: Role,
  budget: boolean,
) {
  let snapshot: Snapshot | undefined,
    issue = "pair_snapshot_missing";
  try {
    snapshot = loadSnapshot(packet, accountId);
  } catch {
    issue = "pair_snapshot_invalid";
  }
  if (snapshot) {
    snapshot.budgetStop = budget;
    if (!budget || !retryableRead(snapshot.errors[role])) return { snapshot, issue: undefined };
    issue = "prepare_read_revalidated";
  } else if (!budget) return { snapshot: undefined, issue };
  const originalError = snapshot?.errors[role];
  // One GET revalidation sequence per role; never retry a submission here.
  const fresh = await prepare(api, accountId, true, undefined, [role]);
  fresh.snapshotMissing = true;
  fresh.priorRequestEvidence = { collector: "missing", dispatcher: "missing" };
  fresh.fallbackDiagnostics = [
    issue,
    ...(originalError ? [originalError] : []),
    ...(await markMainPartial(packet, role)),
  ];
  return { snapshot: fresh, issue: undefined };
}
async function markMainPartial(packet: string, role: Role) {
  const path = `${packet}/${role}-requests.jsonl`;
  if (!existsSync(path)) return [];
  try {
    await fileJournal(path).markIncomplete("fallback_history_incomplete");
    return ["main_chain_partial_marked"];
  } catch {
    return ["main_chain_partial_marker_failed"];
  }
}
