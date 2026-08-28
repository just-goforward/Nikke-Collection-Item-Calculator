import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HpStudyReport } from "./min-ef-hp-report";

export type DynamicHpGateSummary = {
  kind: "dynamic-hp-exact-gate-summary";
  version: 1;
  generatedAt: string;
  decisionScope: { researchOnly: true; productAdoptionAuthorized: false };
  profileCount: number;
  allProfilesComplete: boolean;
  candidateCount: number;
  profiles: Array<{
    id: string;
    forecastProfileId: string;
    screeningRecords: number;
    shortlistIds: string[];
    exactRecords: number;
    passedGates: number;
    failedGates: number;
    incompleteGates: number;
    finalistIds: string[];
  }>;
  candidates: Array<{
    candidateId: string;
    status: "passed_all_profiles" | "rejected" | "screened_out" | "verification_incomplete";
    profilesScreened: number;
    profilesShortlisted: number;
    exactNotSelected: number;
    exactPassed: number;
    exactFailed: number;
    exactIncomplete: number;
  }>;
};

type CandidateAggregate = Omit<
  DynamicHpGateSummary["candidates"][number],
  "candidateId" | "status"
>;

function emptyCandidateAggregate(): CandidateAggregate {
  return {
    profilesScreened: 0,
    profilesShortlisted: 0,
    exactNotSelected: 0,
    exactPassed: 0,
    exactFailed: 0,
    exactIncomplete: 0,
  };
}

function classifyExactCandidate(report: HpStudyReport, candidateId: string) {
  if (!report.screening.shortlistIds.includes(candidateId)) return "not_selected" as const;
  const gates = report.exact.gates.filter((entry) => entry.candidateId === candidateId);
  if (
    gates.length === 0 ||
    gates.some((entry) => entry.gate.status === "verification_incomplete")
  ) {
    return "incomplete" as const;
  }
  if (gates.some((entry) => entry.gate.status === "failed")) return "failed" as const;
  return gates.length === report.options.exactScenarioIds.length
    ? ("passed" as const)
    : ("incomplete" as const);
}

function updateCandidateAggregate(
  aggregate: CandidateAggregate,
  report: HpStudyReport,
  id: string,
) {
  if (report.screening.complete) aggregate.profilesScreened += 1;
  if (report.screening.shortlistIds.includes(id)) aggregate.profilesShortlisted += 1;
  const outcome = classifyExactCandidate(report, id);
  if (outcome === "not_selected") aggregate.exactNotSelected += 1;
  else if (outcome === "passed") aggregate.exactPassed += 1;
  else if (outcome === "failed") aggregate.exactFailed += 1;
  else aggregate.exactIncomplete += 1;
}

function summarizeProfile(id: string, report: HpStudyReport) {
  return {
    id,
    forecastProfileId: report.options.supplyForecast.forecastProfileId,
    screeningRecords: report.screening.records.length,
    shortlistIds: report.screening.shortlistIds,
    exactRecords: report.exact.records.length,
    passedGates: report.exact.gates.filter((entry) => entry.gate.status === "passed").length,
    failedGates: report.exact.gates.filter((entry) => entry.gate.status === "failed").length,
    incompleteGates: report.exact.gates.filter(
      (entry) => entry.gate.status === "verification_incomplete",
    ).length,
    finalistIds: report.exact.finalistIds,
  };
}

function aggregateCandidateStatus(aggregate: CandidateAggregate, profileCount: number) {
  if (aggregate.exactIncomplete > 0) return "verification_incomplete" as const;
  if (aggregate.exactFailed > 0) return "rejected" as const;
  if (aggregate.exactPassed === profileCount) return "passed_all_profiles" as const;
  return "screened_out" as const;
}

export function summarizeDynamicHpGates(
  reports: ReadonlyArray<{ id: string; report: HpStudyReport }>,
  generatedAt = new Date().toISOString(),
): DynamicHpGateSummary {
  if (reports.length === 0) throw new Error("dynamic_hp_reports_missing");
  const candidateIds = new Set<string>();
  const candidates = new Map<string, CandidateAggregate>();
  const profiles = reports
    .map(({ id, report }) => {
      assertReport(report);
      for (const candidate of report.options.candidates) candidateIds.add(candidate.id);
      for (const candidate of report.options.candidates) {
        const aggregate = candidates.get(candidate.id) ?? emptyCandidateAggregate();
        updateCandidateAggregate(aggregate, report, candidate.id);
        candidates.set(candidate.id, aggregate);
      }
      return summarizeProfile(id, report);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    kind: "dynamic-hp-exact-gate-summary",
    version: 1,
    generatedAt,
    decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    profileCount: reports.length,
    allProfilesComplete: reports.every((entry) => entry.report.exact.complete),
    candidateCount: candidateIds.size,
    profiles,
    candidates: [...candidates.entries()]
      .map(([candidateId, value]) => ({
        candidateId,
        status: aggregateCandidateStatus(value, reports.length),
        ...value,
      }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  };
}

async function main() {
  const inputDirectory = resolve(process.argv[2] ?? "benchmarks/results/dynamic");
  const outputFile = resolve(
    process.argv[3] ?? "benchmarks/results/dynamic-hp-exact-gate-summary.json",
  );
  const reports: Array<{ id: string; report: HpStudyReport }> = [];
  await collectReports(inputDirectory, reports);
  const summary = summarizeDynamicHpGates(reports);
  await writeFile(outputFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputFile, ...summary }, null, 2));
}

async function collectReports(
  directory: string,
  result: Array<{ id: string; report: HpStudyReport }>,
) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectReports(path, result);
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      const report = JSON.parse(await readFile(path, "utf8")) as HpStudyReport;
      if (report.kind === "min-ef-hp-study") {
        result.push({ id: basename(entry.name, ".json"), report });
      }
    }
  }
}

function assertReport(report: HpStudyReport) {
  if (
    report.kind !== "min-ef-hp-study" ||
    report.version !== 2 ||
    report.decisionScope.productAdoptionAuthorized !== false
  ) {
    throw new Error("dynamic_hp_report_contract_invalid");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
