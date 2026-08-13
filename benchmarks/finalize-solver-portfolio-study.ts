import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { semanticParity } from "./solver-portfolio-study.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ROOT_URL = new URL("./results/solver-portfolio-study-v1.json", import.meta.url);
const VALIDATION_URL = new URL(
  "./results/solver-portfolio-routing-validation-v1.json",
  import.meta.url,
);
const B2_LATENCY_URL = new URL(
  "./results/min-ef-branch-bound-b2-latency-final.json",
  import.meta.url,
);
const PRIORITIZED_QUALITY_URL = new URL(
  "./results/bounded-hybrid-quality-study-v1.json",
  import.meta.url,
);
const PRIORITIZED_PERFORMANCE_URL = new URL(
  "./results/bounded-hybrid-performance-study-v2.json",
  import.meta.url,
);
const OUTPUT_URL = new URL("./results/solver-portfolio-decision-v1.json", import.meta.url);

type RootRecord = {
  arm: string;
  elapsedMs: number;
  memoryAfterBytes: number;
  memoryBeforeBytes: number;
  outcome: string;
  scenarioId: string;
  semantic: Parameters<typeof semanticParity>[0];
  branchBound?: { prepassMismatches: number };
};

type RootReport = {
  kind: string;
  version: number;
  provenance: Provenance;
  artifacts: {
    product: Fingerprint;
    branchBound: Fingerprint;
    prioritized: Fingerprint;
  };
  contract: { rootLatencyGate: { relativeFactor: number; absoluteMarginMs: number } };
  options: { discoveryScenarioIds: string[]; confirmationScenarioIds: string[] };
  records: RootRecord[];
};

type RoutingRecord = {
  mode: string;
  scenarioId: string;
  memoryAfterBytes: number;
  memoryBeforeBytes: number;
  trace: {
    eligibilityMatched: boolean;
    minEfTier21: { outcome: string };
    rescue: { elapsedMs: number; outcome: string };
    selectedBackend: string | null;
    semantic: Parameters<typeof semanticParity>[0];
    totalElapsedMs: number;
  } | null;
};

type RoutingReport = {
  kind: string;
  version: number;
  provenance: Provenance;
  artifacts: Record<string, Fingerprint>;
  records: RoutingRecord[];
  summary: Record<string, unknown>;
};

type Provenance = {
  version: number;
  studyId: string;
  protocolVersion: number;
  contractSha256: string;
  repoCommit: string;
  sourceFiles: Fingerprint[];
  sourceFingerprint: string;
  wasm?: Fingerprint | null;
};

type Fingerprint = { path: string; bytes: number; sha256: string };

type AuxiliaryReport = {
  kind: string;
  version: number;
  provenance: Provenance;
  [key: string]: unknown;
};

async function main() {
  const [root, validation, b2Latency, prioritizedQuality, prioritizedPerformance] =
    await Promise.all([
      readJson<RootReport>(ROOT_URL),
      readJson<RoutingReport>(VALIDATION_URL),
      readJson<AuxiliaryReport>(B2_LATENCY_URL),
      readJson<AuxiliaryReport>(PRIORITIZED_QUALITY_URL),
      readJson<AuxiliaryReport>(PRIORITIZED_PERFORMANCE_URL),
    ]);
  requireResearchEvidence(root, "solver-portfolio-study", 1, "solver-portfolio-study-v1", [
    "benchmarks/research-provenance.ts",
    "benchmarks/run-solver-portfolio-study.ts",
    "benchmarks/scenarios/solver-portfolio.ts",
    "benchmarks/solver-portfolio-study.ts",
  ]);
  requireResearchEvidence(
    validation,
    "solver-portfolio-routing-validation",
    1,
    "solver-portfolio-routing-validation-v1",
    [
      "benchmarks/research-provenance.ts",
      "benchmarks/run-solver-portfolio-routing-validation.ts",
      "benchmarks/scenarios/solver-portfolio-validation.ts",
      "benchmarks/solver-portfolio-routing-contract.ts",
      "benchmarks/solver-portfolio-routing.ts",
    ],
  );
  requireResearchEvidence(
    b2Latency,
    "min-ef-branch-bound-b2-latency",
    1,
    "min-ef-branch-bound-b2-allocation-warm-latency",
    [
      "benchmarks/research-provenance.ts",
      "benchmarks/run-min-ef-branch-bound-b2-latency.ts",
      "scripts/build-solver-wasm-branch-bound.ts",
    ],
  );
  requireResearchEvidence(
    prioritizedQuality,
    "bounded-hybrid-quality-study",
    1,
    "bounded-hybrid-quality-study-v1",
    [
      "benchmarks/bounded-hybrid-quality.ts",
      "benchmarks/evaluator/exact-replan.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/run-bounded-hybrid-quality-study.ts",
    ],
  );
  requireResearchEvidence(
    prioritizedPerformance,
    "bounded-hybrid-performance-study",
    2,
    "bounded-hybrid-performance-study-v2",
    [
      "benchmarks/latency-report.ts",
      "benchmarks/research-provenance.ts",
      "benchmarks/run-bounded-hybrid-performance-study.ts",
    ],
  );
  requireSameCommit(root.provenance, validation.provenance, "portfolio root and routing reports");
  requireSameCommit(
    b2Latency.provenance,
    prioritizedQuality.provenance,
    "branch-bound and prioritized quality reports",
  );
  requireSameCommit(
    prioritizedQuality.provenance,
    prioritizedPerformance.provenance,
    "prioritized quality and performance reports",
  );
  requireSameFingerprint(
    root.artifacts.product,
    validation.artifacts["product"],
    "product WASM across portfolio reports",
  );
  requireSameFingerprint(
    root.artifacts.branchBound,
    validation.artifacts["branchBound"],
    "branch-bound WASM across portfolio reports",
  );
  await verifyCurrentSources(root.provenance);
  await verifyCurrentSources(validation.provenance);

  const discovery = summarizeCohort(root, new Set(root.options.discoveryScenarioIds));
  const confirmation = summarizeCohort(root, new Set(root.options.confirmationScenarioIds));
  const rootCombined = combineCohorts(discovery, confirmation);
  const routing = summarizeRouting(validation);
  const b2Gate = readDecision(b2Latency, "gate");
  const prioritizedQualityDecision = readDecision(prioritizedQuality, "decision");
  const prioritizedPerformanceDecision = readDecision(prioritizedPerformance, "decision");

  const branchBoundArtifact = root.artifacts.branchBound;
  const prioritizedArtifact = root.artifacts.prioritized;
  requireArtifactAlignment(branchBoundArtifact, b2Latency);
  requireArtifactAlignment(prioritizedArtifact, prioritizedQuality);
  requireArtifactAlignment(prioritizedArtifact, prioritizedPerformance);

  const blockers = [
    `Pre-registered grade route rescued ${rootCombined.preRegisteredRescues}/${rootCombined.fallbacks} fallback roots and passed the root latency gate on ${rootCombined.preRegisteredLatencyPasses}/${rootCombined.fallbacks}.`,
    `Held-out post-failure conditional tier-22 rescue completed ${routing.conditionalCompletions}/${routing.conditionalAttempts}; one failure raised combined memory growth to ${routing.conditionalMaxGrowthMiB.toFixed(2)} MiB.`,
    `Held-out direct tier-22 routing completed ${routing.directCompletions}/${routing.directMatches} rule matches and passed latency on ${routing.directLatencyPasses}/${routing.directMatches}.`,
    `B2 completed ${rootCombined.b2Completions + routing.b2Completions}/${rootCombined.fallbacks + routing.capacityFailures} fallback roots, but post-failure latency passed on ${routing.b2LatencyPasses}/${routing.capacityFailures} held-out roots.`,
    "No static state/stock rule survived the held-out completion, latency, and memory gates.",
    "Bounded prioritized phase2 remains blocked by exact quality, repeated latency, and WASM size gates from its independent studies.",
  ];
  const report = {
    kind: "solver-portfolio-decision",
    version: 1,
    generatedAt: new Date().toISOString(),
    evidence: {
      repoCommit: root.provenance.repoCommit,
      rootStudy: {
        sha256: await sha256File(ROOT_URL),
        discovery,
        confirmation,
        combined: rootCombined,
      },
      routingValidation: {
        sha256: await sha256File(VALIDATION_URL),
        summary: validation.summary,
        analysis: routing,
      },
      b2Latency: { sha256: await sha256File(B2_LATENCY_URL), gate: b2Gate },
      prioritizedQuality: {
        sha256: await sha256File(PRIORITIZED_QUALITY_URL),
        decision: prioritizedQualityDecision,
      },
      prioritizedPerformance: {
        sha256: await sha256File(PRIORITIZED_PERFORMANCE_URL),
        decision: prioritizedPerformanceDecision,
      },
    },
    decision: {
      productCandidate: null,
      keepCurrentLadder: true,
      exactInteractivePortfolioGateRun: false,
      browserGateRun: false,
      androidGateRun: false,
      productAdoptionAuthorized: false,
      blockers,
      reasonForStopping:
        "Every conditional portfolio candidate failed a pre-registered root completion, latency, memory, or independent size/quality gate before exact interactive adoption testing.",
    },
  };
  await writeFile(OUTPUT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

function summarizeCohort(report: RootReport, scenarioIds: Set<string>) {
  const records = report.records.filter((record) => scenarioIds.has(record.scenarioId));
  const byScenario = groupByScenario(records);
  const fallbackRows = [...byScenario.entries()].filter(
    ([, rows]) => row(rows, "min-ef-tier21")?.outcome !== "completed",
  );
  let exactCommon = 0;
  let exactParity = 0;
  let b2Completions = 0;
  let b2Mismatches = 0;
  let preRegisteredRescues = 0;
  let preRegisteredLatencyPasses = 0;
  for (const [scenarioId, rows] of fallbackRows) {
    const tier21 = requiredRow(rows, "min-ef-tier21");
    const tier22 = requiredRow(rows, "min-ef-tier22");
    const b2 = requiredRow(rows, "branch-bound-b2-tier22");
    const phase2 = requiredRow(rows, "phase2-tier22");
    if (tier22.outcome === "completed" && b2.outcome === "completed") {
      exactCommon += 1;
      if (semanticParity(tier22.semantic, b2.semantic)) exactParity += 1;
    }
    if (b2.outcome === "completed") b2Completions += 1;
    b2Mismatches += b2.branchBound?.prepassMismatches ?? 0;
    const selected = isSrScenario(scenarioId) ? b2 : tier22;
    const rescued = selected.outcome === "completed";
    if (rescued) preRegisteredRescues += 1;
    const baselineMs = tier21.elapsedMs + phase2.elapsedMs;
    const candidateMs = tier21.elapsedMs + selected.elapsedMs + (rescued ? 0 : phase2.elapsedMs);
    if (candidateMs <= latencyLimit(report, baselineMs)) preRegisteredLatencyPasses += 1;
  }
  return {
    scenarios: scenarioIds.size,
    fallbacks: fallbackRows.length,
    exactCommon,
    exactParity,
    b2Completions,
    b2Mismatches,
    preRegisteredRescues,
    preRegisteredLatencyPasses,
  };
}

function summarizeRouting(report: RoutingReport) {
  const byScenario = groupByScenario(report.records);
  const comparisons = [...byScenario.entries()].flatMap(([scenarioId, rows]) => {
    const baseline = row(rows, "baseline");
    return baseline ? [{ scenarioId, rows, baseline }] : [];
  });
  const capacity = comparisons.filter(
    ({ baseline }) => baseline.trace?.minEfTier21.outcome !== "completed",
  );
  const conditional = capacity.flatMap(({ rows }) => {
    const candidate = row(rows, "conditional-min-ef-tier22");
    return candidate?.trace?.eligibilityMatched ? [candidate] : [];
  });
  const direct = comparisons.flatMap(({ rows }) => {
    const candidate = row(rows, "direct-conditional-min-ef-tier22");
    return candidate?.trace?.eligibilityMatched ? [candidate] : [];
  });
  const b2 = capacity.flatMap(({ rows }) => {
    const candidate = row(rows, "branch-bound-b2-on-capacity");
    return candidate ? [candidate] : [];
  });
  const conditionalCompleted = conditional.filter(
    (record) => record.trace?.rescue.outcome === "completed",
  );
  const directCompleted = direct.filter((record) => record.trace?.rescue.outcome === "completed");
  const b2Completed = b2.filter((record) => record.trace?.rescue.outcome === "completed");
  const directLatencyPasses = directCompleted.filter((candidate) => {
    const baseline = requiredRow(byScenario.get(candidate.scenarioId) ?? [], "baseline");
    return (
      (candidate.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY) <=
      latencyLimitFromValidation(baseline.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY)
    );
  }).length;
  const b2LatencyPasses = b2Completed.filter((candidate) => {
    const baseline = requiredRow(byScenario.get(candidate.scenarioId) ?? [], "baseline");
    return (
      (candidate.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY) <=
      latencyLimitFromValidation(baseline.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY)
    );
  }).length;
  const b2DirectLatencyPasses = b2Completed.filter((candidate) => {
    const baseline = requiredRow(byScenario.get(candidate.scenarioId) ?? [], "baseline");
    return (
      candidate.trace?.rescue.elapsedMs !== undefined &&
      candidate.trace.rescue.elapsedMs <=
        latencyLimitFromValidation(baseline.trace?.totalElapsedMs ?? Number.POSITIVE_INFINITY)
    );
  }).length;
  const directTier21Common = directCompleted.filter((candidate) => {
    const baseline = requiredRow(byScenario.get(candidate.scenarioId) ?? [], "baseline");
    return baseline.trace?.selectedBackend === "min-ef-tier21";
  });
  const validationExactCommon = capacity.flatMap(({ rows }) => {
    const tier22 = row(rows, "conditional-min-ef-tier22");
    const branchBound = row(rows, "branch-bound-b2-on-capacity");
    return tier22?.trace?.rescue.outcome === "completed" &&
      branchBound?.trace?.rescue.outcome === "completed"
      ? [{ tier22, branchBound }]
      : [];
  });
  return {
    scenarios: comparisons.length,
    capacityFailures: capacity.length,
    conditionalAttempts: conditional.length,
    conditionalCompletions: conditionalCompleted.length,
    conditionalMaxGrowthMiB: maxGrowthMiB(conditional),
    directMatches: direct.length,
    directCompletions: directCompleted.length,
    directLatencyPasses,
    directTier21Common: directTier21Common.length,
    directTier21SemanticParity: directTier21Common.filter((candidate) => {
      const baseline = requiredRow(byScenario.get(candidate.scenarioId) ?? [], "baseline");
      return semanticParity(candidate.trace?.semantic ?? null, baseline.trace?.semantic ?? null);
    }).length,
    directMaxGrowthMiB: maxGrowthMiB(direct),
    b2Attempts: b2.length,
    b2Completions: b2Completed.length,
    b2LatencyPasses,
    b2DirectLatencyPasses,
    validationExactCommon: validationExactCommon.length,
    validationExactParity: validationExactCommon.filter(({ tier22, branchBound }) =>
      semanticParity(tier22.trace?.semantic ?? null, branchBound.trace?.semantic ?? null),
    ).length,
    b2MaxGrowthMiB: maxGrowthMiB(b2),
    baselineCapacityMaxGrowthMiB: maxGrowthMiB(capacity.map(({ baseline }) => baseline)),
  };
}

function combineCohorts(
  left: ReturnType<typeof summarizeCohort>,
  right: ReturnType<typeof summarizeCohort>,
) {
  return {
    scenarios: left.scenarios + right.scenarios,
    fallbacks: left.fallbacks + right.fallbacks,
    exactCommon: left.exactCommon + right.exactCommon,
    exactParity: left.exactParity + right.exactParity,
    b2Completions: left.b2Completions + right.b2Completions,
    b2Mismatches: left.b2Mismatches + right.b2Mismatches,
    preRegisteredRescues: left.preRegisteredRescues + right.preRegisteredRescues,
    preRegisteredLatencyPasses: left.preRegisteredLatencyPasses + right.preRegisteredLatencyPasses,
  };
}

function groupByScenario<T extends { scenarioId: string }>(records: T[]) {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const rows = grouped.get(record.scenarioId) ?? [];
    rows.push(record);
    grouped.set(record.scenarioId, rows);
  }
  return grouped;
}

function row<T extends { mode?: string; arm?: string }>(rows: T[], id: string) {
  return rows.find((entry) => entry.mode === id || entry.arm === id);
}

function requiredRow<T extends { mode?: string; arm?: string }>(rows: T[], id: string) {
  const found = row(rows, id);
  if (!found) throw new Error(`Missing required research row: ${id}.`);
  return found;
}

function isSrScenario(id: string) {
  return id.startsWith("SR") || id.includes("-SR");
}

function latencyLimit(report: RootReport, baselineMs: number) {
  const gate = report.contract.rootLatencyGate;
  return Math.max(baselineMs * gate.relativeFactor, baselineMs + gate.absoluteMarginMs);
}

function latencyLimitFromValidation(baselineMs: number) {
  return Math.max(baselineMs * 1.15, baselineMs + 50);
}

function maxGrowthMiB(records: Array<{ memoryAfterBytes: number; memoryBeforeBytes: number }>) {
  return Math.max(
    0,
    ...records.map((record) => (record.memoryAfterBytes - record.memoryBeforeBytes) / 1_048_576),
  );
}

async function verifyCurrentSources(provenance: Provenance) {
  for (const expected of provenance.sourceFiles) {
    const actual = await fingerprint(resolve(REPO_ROOT, expected.path), expected.path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`Research source changed after measurement: ${expected.path}.`);
    }
  }
}

export function requireResearchEvidence(
  report: { kind: string; version: number; provenance: Provenance },
  kind: string,
  version: number,
  studyId: string,
  requiredSourcePaths: readonly string[],
) {
  requireReport(report, kind, version);
  const { provenance } = report;
  if (provenance.studyId !== studyId) {
    throw new Error(`Unexpected research study: ${provenance.studyId}.`);
  }
  if (!Number.isInteger(provenance.protocolVersion) || provenance.protocolVersion < 1) {
    throw new Error(`Invalid protocol version for ${studyId}.`);
  }
  if (!isSha256(provenance.contractSha256) || !isSha256(provenance.sourceFingerprint)) {
    throw new Error(`Invalid provenance hash for ${studyId}.`);
  }
  if (!/^[0-9a-f]{40}$/u.test(provenance.repoCommit)) {
    throw new Error(`Invalid repository commit for ${studyId}.`);
  }
  const paths = provenance.sourceFiles.map((source) => source.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error(`Duplicate research source path for ${studyId}.`);
  }
  for (const source of provenance.sourceFiles) requireFingerprint(source, studyId);
  const sourceFingerprint = fingerprintSourceEntries(provenance.sourceFiles);
  if (sourceFingerprint !== provenance.sourceFingerprint) {
    throw new Error(`Source fingerprint metadata mismatch for ${studyId}.`);
  }
  for (const requiredPath of requiredSourcePaths) {
    if (!paths.includes(requiredPath)) {
      throw new Error(`Required research source is missing for ${studyId}: ${requiredPath}.`);
    }
  }
}

function requireArtifactAlignment(
  expected: Fingerprint | undefined,
  report: { provenance: Provenance },
) {
  if (!expected) throw new Error("Missing expected candidate artifact fingerprint.");
  const actual = report.provenance.wasm;
  if (
    !actual ||
    actual.path !== expected.path ||
    actual.sha256 !== expected.sha256 ||
    actual.bytes !== expected.bytes
  ) {
    throw new Error(`Candidate artifact mismatch for ${expected.path}.`);
  }
}

function requireSameCommit(left: Provenance, right: Provenance, label: string) {
  if (left.repoCommit !== right.repoCommit) {
    throw new Error(`Repository commit mismatch for ${label}.`);
  }
}

function requireSameFingerprint(
  left: Fingerprint | undefined,
  right: Fingerprint | undefined,
  label: string,
) {
  if (
    !left ||
    !right ||
    left.path !== right.path ||
    left.bytes !== right.bytes ||
    left.sha256 !== right.sha256
  ) {
    throw new Error(`Artifact fingerprint mismatch for ${label}.`);
  }
}

function requireFingerprint(fingerprint: Fingerprint, studyId: string) {
  if (
    !fingerprint.path ||
    !Number.isInteger(fingerprint.bytes) ||
    fingerprint.bytes < 0 ||
    !isSha256(fingerprint.sha256)
  ) {
    throw new Error(`Invalid source fingerprint entry for ${studyId}.`);
  }
}

function fingerprintSourceEntries(sourceFiles: readonly Fingerprint[]) {
  const entries = [...sourceFiles]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`)
    .join("\n");
  return createHash("sha256").update(entries).digest("hex");
}

function isSha256(value: string) {
  return /^[0-9a-f]{64}$/u.test(value);
}

function readDecision(report: Record<string, unknown>, key: string) {
  const decision = report[key];
  if (!decision || typeof decision !== "object") throw new Error(`Missing ${key} decision.`);
  return decision;
}

function requireReport(report: { kind: string; version: number }, kind: string, version: number) {
  if (report.kind !== kind || report.version !== version) {
    throw new Error(`Unexpected research report: ${report.kind} v${report.version}.`);
  }
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

async function sha256File(url: URL) {
  return createHash("sha256")
    .update(await readFile(url))
    .digest("hex");
}

async function fingerprint(path: string, relativePath: string): Promise<Fingerprint> {
  const contents = await readFile(path);
  return {
    path: relativePath,
    bytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
