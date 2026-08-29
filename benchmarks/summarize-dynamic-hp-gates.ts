import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DynamicHpEvidenceProfile,
  type DynamicHpProfile,
  gainVectorSha256,
} from "./dynamic-hp-profile-matrix";
import type { HpStudyReport } from "./min-ef-hp-report";

export type DynamicHpGateSummary = {
  kind: "dynamic-hp-exact-gate-summary";
  version: 2;
  generatedAt: string;
  decisionScope: { researchOnly: true; productAdoptionAuthorized: false };
  profileCount: number;
  evaluatedProfileCount: number;
  uniqueGainVectorCount: number;
  duplicateProfileCount: number;
  allProfilesComplete: boolean;
  candidateCount: number;
  certificate: {
    identity: "dynamic-hp-gain-vector-certificate-v1";
    solverWasmSha256: string | null;
    rulesVersion: string | null;
    candidateGridSha256: string;
    screeningScenarioSetSha256: string;
    exactScenarioSetSha256: string;
  };
  profiles: Array<{
    id: string;
    forecastProfileId: string;
    gainVectorSha256: string;
    expectedGain: { blue: number; purple: number; yellow: number };
    evidenceProfileIds: string[];
    evidenceForecastProfileIds: string[];
    resultContractSha256: string;
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

type SummaryOptions = {
  matrix?: readonly DynamicHpProfile[];
  solverWasmSha256?: string;
  rulesVersion?: string;
};

type ReportGroup = {
  gainVectorSha256: string;
  reports: Array<{ id: string; report: HpStudyReport }>;
  evidenceProfiles: Map<string, DynamicHpEvidenceProfile>;
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

function summarizeProfile(group: ReportGroup) {
  const canonical = group.reports[0];
  if (!canonical) throw new Error("dynamic_hp_gain_group_empty");
  const resultContractSha256 = reportResultContractSha256(canonical.report);
  for (const duplicate of group.reports.slice(1)) {
    if (reportResultContractSha256(duplicate.report) !== resultContractSha256) {
      throw new Error(`dynamic_hp_duplicate_gain_result_conflict:${group.gainVectorSha256}`);
    }
  }
  const evidenceProfiles = [...group.evidenceProfiles.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return {
    id: canonical.id,
    forecastProfileId: canonical.report.options.supplyForecast.forecastProfileId,
    gainVectorSha256: group.gainVectorSha256,
    expectedGain: canonical.report.options.supplyForecast.expectedGain,
    evidenceProfileIds: evidenceProfiles.map((profile) => profile.id),
    evidenceForecastProfileIds: evidenceProfiles.map(
      (profile) => profile.context.forecastProfileId,
    ),
    resultContractSha256,
    screeningRecords: canonical.report.screening.records.length,
    shortlistIds: canonical.report.screening.shortlistIds,
    exactRecords: canonical.report.exact.records.length,
    passedGates: canonical.report.exact.gates.filter((entry) => entry.gate.status === "passed")
      .length,
    failedGates: canonical.report.exact.gates.filter((entry) => entry.gate.status === "failed")
      .length,
    incompleteGates: canonical.report.exact.gates.filter(
      (entry) => entry.gate.status === "verification_incomplete",
    ).length,
    finalistIds: canonical.report.exact.finalistIds,
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
  options: SummaryOptions = {},
): DynamicHpGateSummary {
  if (reports.length === 0) throw new Error("dynamic_hp_reports_missing");
  const groups = groupReportsByGain(reports, options.matrix);
  const canonicalReports = groups.map((group) => {
    const canonical = group.reports[0];
    if (!canonical) throw new Error("dynamic_hp_gain_group_empty");
    return canonical;
  });
  const contract = assertSharedResearchContract(canonicalReports.map((entry) => entry.report));
  const candidateIds = new Set<string>();
  const candidates = new Map<string, CandidateAggregate>();
  const profiles = groups
    .map((group) => {
      const canonical = group.reports[0];
      if (!canonical) throw new Error("dynamic_hp_gain_group_empty");
      const { report } = canonical;
      assertReport(report);
      for (const candidate of report.options.candidates) candidateIds.add(candidate.id);
      for (const candidate of report.options.candidates) {
        const aggregate = candidates.get(candidate.id) ?? emptyCandidateAggregate();
        updateCandidateAggregate(aggregate, report, candidate.id);
        candidates.set(candidate.id, aggregate);
      }
      return summarizeProfile(group);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const evidenceProfileCount = new Set(
    groups.flatMap((group) => [...group.evidenceProfiles.keys()]),
  ).size;
  return {
    kind: "dynamic-hp-exact-gate-summary",
    version: 2,
    generatedAt,
    decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    profileCount: evidenceProfileCount,
    evaluatedProfileCount: reports.length,
    uniqueGainVectorCount: groups.length,
    duplicateProfileCount: evidenceProfileCount - groups.length,
    allProfilesComplete: reports.every((entry) => entry.report.exact.complete),
    candidateCount: candidateIds.size,
    certificate: {
      identity: "dynamic-hp-gain-vector-certificate-v1",
      solverWasmSha256: options.solverWasmSha256 ?? null,
      rulesVersion: options.rulesVersion ?? null,
      ...contract,
    },
    profiles,
    candidates: [...candidates.entries()]
      .map(([candidateId, value]) => ({
        candidateId,
        status: aggregateCandidateStatus(value, groups.length),
        ...value,
      }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  };
}

function groupReportsByGain(
  reports: ReadonlyArray<{ id: string; report: HpStudyReport }>,
  matrix: readonly DynamicHpProfile[] | undefined,
): ReportGroup[] {
  const reportsById = new Map(reports.map((entry) => [entry.id, entry]));
  if (reportsById.size !== reports.length) throw new Error("dynamic_hp_duplicate_report_id");
  const groups = new Map<string, ReportGroup>();

  if (matrix) {
    for (const profile of matrix) {
      const report = reportsById.get(profile.id);
      if (!report) throw new Error(`dynamic_hp_matrix_report_missing:${profile.id}`);
      const actualIdentity = gainVectorSha256(report.report.options.supplyForecast.expectedGain);
      if (actualIdentity !== profile.gainVectorSha256) {
        throw new Error(`dynamic_hp_matrix_gain_drift:${profile.id}`);
      }
      addReportGroup(groups, actualIdentity, report, profile.evidenceProfiles);
      reportsById.delete(profile.id);
    }
    if (reportsById.size > 0) throw new Error("dynamic_hp_report_outside_matrix");
  } else {
    for (const report of reports) {
      const identity = gainVectorSha256(report.report.options.supplyForecast.expectedGain);
      addReportGroup(groups, identity, report, [evidenceFromReport(report)]);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      reports: group.reports.sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.gainVectorSha256.localeCompare(right.gainVectorSha256));
}

function addReportGroup(
  groups: Map<string, ReportGroup>,
  identity: string,
  report: { id: string; report: HpStudyReport },
  evidenceProfiles: readonly DynamicHpEvidenceProfile[],
) {
  const group = groups.get(identity) ?? {
    gainVectorSha256: identity,
    reports: [],
    evidenceProfiles: new Map<string, DynamicHpEvidenceProfile>(),
  };
  group.reports.push(report);
  for (const evidence of evidenceProfiles) group.evidenceProfiles.set(evidence.id, evidence);
  groups.set(identity, group);
}

function evidenceFromReport(entry: {
  id: string;
  report: HpStudyReport;
}): DynamicHpEvidenceProfile {
  return {
    id: entry.id,
    cycleDays: null,
    scheduleStatus: "estimated",
    phase: "approved",
    context: entry.report.options.supplyForecast,
  };
}

function reportResultContractSha256(report: HpStudyReport): string {
  const screeningRecords = report.screening.records.map(
    ({ elapsedMs: _elapsedMs, ...record }) => record,
  );
  const exactRecords = report.exact.records.map((record) => {
    const {
      elapsedMs: _elapsedMs,
      solveCalls: _solveCalls,
      cachedNodes: _cachedNodes,
      cachedPolicies: _cachedPolicies,
      ...evaluation
    } = record.evaluation;
    return { ...record, evaluation };
  });
  return sha256Json({
    baselineVerification: report.baselineVerification,
    screening: {
      complete: report.screening.complete,
      records: screeningRecords,
      summaries: report.screening.summaries,
      shortlistIds: report.screening.shortlistIds,
    },
    exact: {
      complete: report.exact.complete,
      records: exactRecords,
      gates: report.exact.gates,
      finalistIds: report.exact.finalistIds,
    },
    candidateGrades: report.candidateGrades,
  });
}

function assertSharedResearchContract(reports: readonly HpStudyReport[]) {
  const first = reports[0];
  if (!first) throw new Error("dynamic_hp_reports_missing");
  const contract = {
    candidateGridSha256: sha256Json(first.options.candidates),
    screeningScenarioSetSha256: sha256Json(first.options.scenarioIds),
    exactScenarioSetSha256: sha256Json(first.options.exactScenarioIds),
  };
  for (const report of reports.slice(1)) {
    if (
      sha256Json(report.options.candidates) !== contract.candidateGridSha256 ||
      sha256Json(report.options.scenarioIds) !== contract.screeningScenarioSetSha256 ||
      sha256Json(report.options.exactScenarioIds) !== contract.exactScenarioSetSha256
    ) {
      throw new Error("dynamic_hp_research_contract_drift");
    }
  }
  return contract;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  const inputDirectory = resolve(process.argv[2] ?? "benchmarks/results/dynamic");
  const outputFile = resolve(
    process.argv[3] ?? "benchmarks/results/dynamic-hp-exact-gate-summary.json",
  );
  const matrixFile = process.argv[4] ? resolve(process.argv[4]) : null;
  const solverWasmSha256 = process.argv[5];
  const rulesVersion = process.argv[6];
  const reports: Array<{ id: string; report: HpStudyReport }> = [];
  await collectReports(inputDirectory, reports);
  const matrix = matrixFile
    ? (JSON.parse(await readFile(matrixFile, "utf8")) as DynamicHpProfile[])
    : undefined;
  const summary = summarizeDynamicHpGates(reports, new Date().toISOString(), {
    ...(matrix ? { matrix } : {}),
    ...(solverWasmSha256 ? { solverWasmSha256 } : {}),
    ...(rulesVersion ? { rulesVersion } : {}),
  });
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
