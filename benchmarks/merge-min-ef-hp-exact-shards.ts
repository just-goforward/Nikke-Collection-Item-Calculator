import { readdir } from "node:fs/promises";

import { readHpStudyReport, writeHpStudyReport } from "./min-ef-hp-report.ts";

const REPORT_FILE = new URL("./results/min-ef-hp-study.json", import.meta.url);
const SHARD_DIRECTORY = new URL("./results/min-ef-hp-shards/", import.meta.url);

const report = await readHpStudyReport(REPORT_FILE);
if (!report) throw new Error("The canonical H/p study report does not exist.");

const byKey = new Map(
  report.exact.records.map((record) => [`${record.candidateId}\0${record.scenarioId}`, record]),
);
const names = (await readdir(SHARD_DIRECTORY)).filter((name) => name.endsWith(".json")).sort();
for (const name of names) {
  const shard = await readHpStudyReport(new URL(name, SHARD_DIRECTORY));
  if (!shard) continue;
  assertCompatible(report, shard, name);
  for (const record of shard.exact.records) {
    const key = `${record.candidateId}\0${record.scenarioId}`;
    const current = byKey.get(key);
    if (!current || current.evaluation.status === "verification_incomplete") {
      byKey.set(key, record);
    } else if (
      record.evaluation.status !== "verification_incomplete" &&
      current.evaluation.status !== record.evaluation.status
    ) {
      throw new Error(`Conflicting terminal H/p exact outcomes for ${record.candidateId}.`);
    }
  }
}

const candidateOrder = new Map(
  report.options.candidates.map((candidate, index) => [candidate.id, index]),
);
const scenarioOrder = new Map(report.options.exactScenarioIds.map((id, index) => [id, index]));
report.exact.records = [...byKey.values()].sort(
  (left, right) =>
    (candidateOrder.get(left.candidateId) ?? Number.MAX_SAFE_INTEGER) -
      (candidateOrder.get(right.candidateId) ?? Number.MAX_SAFE_INTEGER) ||
    (scenarioOrder.get(left.scenarioId) ?? Number.MAX_SAFE_INTEGER) -
      (scenarioOrder.get(right.scenarioId) ?? Number.MAX_SAFE_INTEGER),
);
report.exact.complete = false;
report.exact.gates = [];
report.exact.finalistIds = [];
await writeHpStudyReport(REPORT_FILE, report);

console.log(
  JSON.stringify(
    {
      shards: names.length,
      exactRecords: report.exact.records.length,
      output: REPORT_FILE.pathname,
    },
    null,
    2,
  ),
);

function assertCompatible(
  canonical: NonNullable<Awaited<ReturnType<typeof readHpStudyReport>>>,
  shard: NonNullable<Awaited<ReturnType<typeof readHpStudyReport>>>,
  name: string,
): void {
  const sameCandidates =
    JSON.stringify(canonical.options.candidates) === JSON.stringify(shard.options.candidates);
  const sameScenarios =
    JSON.stringify(canonical.options.exactScenarioIds) ===
    JSON.stringify(shard.options.exactScenarioIds);
  if (!sameCandidates || !sameScenarios) {
    throw new Error(`H/p exact shard ${name} does not match the canonical study contract.`);
  }
}
