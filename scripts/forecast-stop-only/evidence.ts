import { constants, copyFileSync, readFileSync } from "node:fs";
import { z } from "zod";
import { fileJournal } from "./journal.ts";
import { reason } from "./registry.ts";
import type { Journal, Role, RoleEvidence } from "./types.ts";
import { roles } from "./types.ts";

export async function copyBaselines(packet: string, source?: string) {
  const states: RoleEvidence = { collector: "missing", dispatcher: "missing" };
  const issues: Partial<Record<Role, string>> = {};
  for (const role of roles) {
    if (!source) continue;
    try {
      const from = `${source}/${role}-requests.jsonl`,
        journal = fileJournal(from, "provided");
      await journal.read();
      const state = journal.baselineEvidence;
      states[role] = state === "unavailable" ? "missing" : state;
      if (state !== "provided") continue;
      const to = `${packet}/${role}-requests.jsonl`;
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      copyFileSync(`${from}.origin.json`, `${to}.origin.json`, constants.COPYFILE_EXCL);
    } catch (error) {
      issues[role] = reason(error);
      states[role] = issues[role] === "request_evidence_missing" ? "missing" : "invalid";
    }
  }
  return { states, issues };
}
export function epochBaseline(path?: string) {
  if (!path) return { baseline: undefined, issue: undefined };
  try {
    return {
      baseline: z
        .number()
        .int()
        .positive()
        .parse(JSON.parse(readFileSync(path, "utf8")).epoch),
      issue: undefined,
    };
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return { baseline: undefined, issue: missing ? undefined : "epoch_baseline_invalid" };
  }
}
export async function inspectJournal(journal: Journal) {
  const trusted = journal.baselineEvidence === "provided";
  try {
    const latest = new Map<string, string>();
    for (const r of await journal.read()) latest.set(r.attempt.requestId, r.state);
    return {
      historyTrusted: trusted,
      priorUnresolved: [...latest.values()].some((s) => !["resolved", "not_submitted"].includes(s)),
      diagnostics: trusted ? [] : ["request_history_incomplete"],
    };
  } catch (error) {
    return {
      historyTrusted: false,
      priorUnresolved: false,
      diagnostics: ["request_history_incomplete", reason(error)],
    };
  }
}
