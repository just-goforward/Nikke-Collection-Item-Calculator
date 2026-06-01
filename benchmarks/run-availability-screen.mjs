import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const JSON_OUTPUT_FILE = new URL("./results/availability-screen.json", import.meta.url);
const CSV_OUTPUT_FILE = new URL("./results/availability-screen-configs.csv", import.meta.url);

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseBoolean(value) {
  return value === "1" || value === "true";
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const topK = parsePositiveInteger(process.env.AVAILABILITY_SCREEN_TOP_K, 20);
const scenarioLimit = parsePositiveInteger(
  process.env.AVAILABILITY_SCREEN_LIMIT,
  Number.POSITIVE_INFINITY,
);
const includePreservationProbes = parseBoolean(
  process.env.AVAILABILITY_SCREEN_INCLUDE_PRESERVATION,
);
const includeSensitivityProbes = parseBoolean(process.env.AVAILABILITY_SCREEN_INCLUDE_SENSITIVITY);
const requestedScenarios = new Set(
  String(process.env.AVAILABILITY_SCREEN_SCENARIOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

await mkdir(RESULTS_DIRECTORY, { recursive: true });

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const grid = await server.ssrLoadModule("/benchmarks/scenarios/fixed-grid.ts");
  const availability = await server.ssrLoadModule("/benchmarks/models/availability-grid.ts");
  const screen = await server.ssrLoadModule("/benchmarks/evaluator/availability-screen.ts");

  const candidates = availability.buildAvailabilityGridCandidates({
    includePreservationProbes,
    includeSensitivityProbes,
  });
  const scenarios = grid.FIXED_SAFETY_GRID.filter(
    (scenario) => requestedScenarios.size === 0 || requestedScenarios.has(scenario.id),
  ).slice(0, scenarioLimit);

  const startedAt = performance.now();
  const records = [];
  for (const scenario of scenarios) {
    const input = { start: scenario.start, stock: scenario.stock, strategy: "supply" };
    const baselineResult = availability.solveAvailabilityCandidate(
      input,
      availability.BASELINE_AVAILABILITY_CANDIDATE,
    );
    for (const candidate of candidates) {
      records.push(screen.screenAvailabilityCandidate(scenario, candidate, baselineResult));
    }
  }

  const byCandidate = new Map();
  for (const candidate of candidates) {
    byCandidate.set(candidate.id, {
      ...candidate,
      status: "budget-deprioritized",
      scenarioCount: 0,
      screenedCount: 0,
      hardInfeasibleCount: 0,
      errorCount: 0,
      firstActionChangedCount: 0,
      runCountChangedCount: 0,
      eligibleEmptyTotal: 0,
      fixedToleranceViolationTotal: 0,
      maxChosenGap: 0,
      promoteScoreTotal: 0,
      promoteScoreMax: 0,
      lowTopSuccessGapCount: 0,
      lowTopResourceGapCount: 0,
    });
  }

  for (const record of records) {
    const summary = byCandidate.get(record.candidateId);
    summary.scenarioCount += 1;
    if (record.status === "screened") summary.screenedCount += 1;
    if (record.status === "hard-infeasible") summary.hardInfeasibleCount += 1;
    if (record.status === "error") summary.errorCount += 1;
    if (record.firstActionChanged) summary.firstActionChangedCount += 1;
    if (record.runCountChanged) summary.runCountChangedCount += 1;
    summary.eligibleEmptyTotal += record.eligibleEmptyCount;
    summary.fixedToleranceViolationTotal += record.fixedToleranceViolationCount;
    summary.maxChosenGap = Math.max(summary.maxChosenGap, record.maxChosenGap);
    summary.promoteScoreTotal += record.promoteScore;
    summary.promoteScoreMax = Math.max(summary.promoteScoreMax, record.promoteScore);
    if (record.topSuccessProbabilityGap !== null && record.topSuccessProbabilityGap <= 0.003) {
      summary.lowTopSuccessGapCount += 1;
    }
    if (record.topResourceCostGap !== null && record.topResourceCostGap <= 0.01) {
      summary.lowTopResourceGapCount += 1;
    }
  }

  const summaries = Array.from(byCandidate.values()).sort((left, right) => {
    if (left.id === availability.BASELINE_AVAILABILITY_CANDIDATE.id) return -1;
    if (right.id === availability.BASELINE_AVAILABILITY_CANDIDATE.id) return 1;
    return (
      right.promoteScoreTotal - left.promoteScoreTotal ||
      right.promoteScoreMax - left.promoteScoreMax ||
      right.maxChosenGap - left.maxChosenGap ||
      right.eligibleEmptyTotal - left.eligibleEmptyTotal ||
      left.id.localeCompare(right.id)
    );
  });

  const selectedIds = new Set([availability.BASELINE_AVAILABILITY_CANDIDATE.id]);
  function selectBy(predicate) {
    const match = summaries.find((summary) => !selectedIds.has(summary.id) && predicate(summary));
    if (match) selectedIds.add(match.id);
  }

  // Keep exact-deep input coverage broad; stage labels are assigned only after deep evaluation.
  selectBy((summary) => summary.horizonFactor === 0);
  selectBy((summary) => summary.horizonFactor === 1);
  selectBy((summary) => summary.tolerance === 0);
  selectBy((summary) => summary.tolerance === 0.03);
  selectBy((summary) => summary.horizonFactor === 0 && summary.tolerance === 0.03);
  selectBy((summary) => summary.horizonFactor === 1 && summary.tolerance === 0);
  selectBy((summary) => summary.promoteScoreTotal > 0);

  for (const summary of summaries) {
    if (selectedIds.size >= topK) break;
    selectedIds.add(summary.id);
  }

  for (const summary of summaries) {
    if (selectedIds.has(summary.id)) summary.status = "deep-candidate";
  }

  const report = {
    kind: "availability-screen",
    version: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedAt),
    topK,
    options: {
      includePreservationProbes,
      includeSensitivityProbes,
      scenarioLimit: Number.isFinite(scenarioLimit) ? scenarioLimit : null,
      requestedScenarios: Array.from(requestedScenarios),
    },
    candidateCount: candidates.length,
    scenarioCount: scenarios.length,
    recordCount: records.length,
    deepCandidateIds: Array.from(selectedIds),
    candidates: summaries,
    records,
  };

  await writeFile(JSON_OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const columns = [
    "id",
    "status",
    "role",
    "tolerance",
    "horizonFactor",
    "horizonDays",
    "normPower",
    "scenarioCount",
    "screenedCount",
    "hardInfeasibleCount",
    "errorCount",
    "firstActionChangedCount",
    "runCountChangedCount",
    "eligibleEmptyTotal",
    "fixedToleranceViolationTotal",
    "maxChosenGap",
    "promoteScoreTotal",
    "promoteScoreMax",
    "lowTopSuccessGapCount",
    "lowTopResourceGapCount",
  ];
  const csv = [
    columns.join(","),
    ...summaries.map((summary) => columns.map((column) => csvEscape(summary[column])).join(",")),
  ].join("\n");
  await writeFile(CSV_OUTPUT_FILE, `${csv}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        elapsedMs: report.elapsedMs,
        candidateCount: report.candidateCount,
        scenarioCount: report.scenarioCount,
        recordCount: report.recordCount,
        deepCandidateIds: report.deepCandidateIds,
        json: JSON_OUTPUT_FILE.pathname,
        csv: CSV_OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
