import { writeFile } from "node:fs/promises";
import { createServer } from "vite";

import { readHpStudyReport, writeHpStudyReport } from "./min-ef-hp-report.ts";
import { envValue } from "./runner-utils.ts";

const REPORT_FILE = new URL(
  envValue("HP_STUDY_REPORT_FILE") ?? "min-ef-hp-study.json",
  new URL("./results/", import.meta.url),
);
const KO_FINDINGS = new URL(
  envValue("HP_STUDY_FINDINGS_KO") ?? "../docs/research/min-ef-hp-study-findings.ko.md",
  import.meta.url,
);
const EN_FINDINGS = new URL(
  envValue("HP_STUDY_FINDINGS_EN") ?? "../docs/research/min-ef-hp-study-findings.md",
  import.meta.url,
);
const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});

try {
  const report = await readHpStudyReport(REPORT_FILE);
  if (!report) throw new Error("Missing H/p study report.");
  const quality = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-quality.ts",
  )) as typeof import("./min-ef-hp-quality");
  const significance = (await server.ssrLoadModule(
    "/benchmarks/significance-gate.ts",
  )) as typeof import("./significance-gate");
  const tail = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-tail.ts",
  )) as typeof import("./min-ef-hp-tail");
  const candidateIds = report.screening.shortlistIds.filter(
    (candidateId) => candidateId !== report.baselineVerification.candidateId,
  );
  report.candidateGrades = candidateIds.map((candidateId) => {
    const exactGates = report.exact.gates
      .filter((entry) => entry.candidateId === candidateId)
      .map((entry) => entry.gate);
    const confirmationDecision = decisionFor(report.tailRisk, "confirmationDecisions", candidateId);
    const discoveryDecision = decisionFor(report.tailRisk, "discoveryDecisions", candidateId);
    const tailDecision =
      confirmationDecision ?? (readPassed(discoveryDecision) === false ? discoveryDecision : null);
    const d1Decision = decisionFor(report.d1Robustness, "decisions", candidateId);
    const performanceRecords = (report.performance.records as PerformanceRecord[]).filter(
      (record) => record.candidateId === candidateId,
    );
    const performancePassed =
      report.performance.status === "completed"
        ? performanceRecords.length > 0 &&
          performanceRecords.every((record) => record.status === "completed" && record.passed)
        : null;
    const screen = report.screening.summaries.find(
      (summary) => summary.candidateId === candidateId,
    );
    return {
      candidateId,
      grade: quality.classifyHpCandidate({
        exactGates,
        tailRiskPassed: readPassed(tailDecision),
        d1RobustnessPassed: readPassed(d1Decision),
        performancePassed,
        hasStrictTailImprovement: readTailImprovement(tailDecision),
        hasNewFailure: (screen?.newFailures ?? 1) > 0,
      }),
    };
  });
  const productCandidates = report.candidateGrades
    .filter((entry) => entry.grade === "product_candidate")
    .map((entry) => entry.candidateId);
  const tailSelection = selectConfirmedTailRisk(
    report.tailRisk,
    productCandidates,
    significance,
    tail,
  );
  Object.assign(report, {
    finalDecision: {
      status: productCandidates.length > 0 ? "candidate_available" : "keep_baseline",
      selectedCandidateId:
        tailSelection.selectedCandidateId ?? report.baselineVerification.candidateId,
      runtimeChangeAuthorized: false,
      productCandidates,
      tailSelection,
    },
  });
  await writeHpStudyReport(REPORT_FILE, report);
  await writeFile(KO_FINDINGS, koreanFindings(report), "utf8");
  await writeFile(EN_FINDINGS, englishFindings(report), "utf8");
  console.log(
    JSON.stringify(
      {
        candidateGrades: report.candidateGrades,
        finalDecision: (report as HpStudyWithDecision).finalDecision,
        findings: [KO_FINDINGS.pathname, EN_FINDINGS.pathname],
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}

type PerformanceRecord = {
  candidateId: string;
  status: "completed" | "failure";
  passed?: boolean;
};

type HpStudyWithDecision = Awaited<ReturnType<typeof readHpStudyReport>> & {
  finalDecision: {
    status: string;
    selectedCandidateId: string;
    runtimeChangeAuthorized: false;
    productCandidates: string[];
    tailSelection: TailSelection;
  };
};

function decisionFor(section: object, key: string, candidateId: string): unknown {
  const value = section as Record<string, unknown>;
  const decisions = value[key];
  if (!Array.isArray(decisions)) return null;
  return decisions.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "candidateId" in entry &&
      entry.candidateId === candidateId,
  );
}

function readPassed(decision: unknown): boolean | null {
  if (typeof decision !== "object" || decision === null || !("passed" in decision)) return null;
  return typeof decision.passed === "boolean" ? decision.passed : null;
}

function readTailImprovement(decision: unknown): boolean {
  if (typeof decision !== "object" || decision === null || !("result" in decision)) return false;
  const result = decision.result;
  return (
    typeof result === "object" &&
    result !== null &&
    "hasStrictImprovement" in result &&
    result.hasStrictImprovement === true
  );
}

type TailSelection = {
  selectedCandidateId: string | null;
  pointBestCandidateId: string | null;
  statisticallyTiedCandidateIds: string[];
};

type CompletedTailRecord = {
  phase: "confirmation";
  candidateId: string;
  panelId: string;
  seed: number;
  runs: number;
  status: "completed";
  completionRate: number;
  maxSupplyDebtDaysSamples: number[];
};

function selectConfirmedTailRisk(
  section: object,
  candidateIds: readonly string[],
  significance: typeof import("./significance-gate"),
  tail: typeof import("./min-ef-hp-tail"),
): TailSelection {
  const candidates = candidateIds.flatMap((candidateId) => {
    const decision = decisionFor(section, "confirmationDecisions", candidateId);
    if (typeof decision !== "object" || decision === null || !("result" in decision)) return [];
    const result = decision.result;
    if (typeof result !== "object" || result === null || !("panels" in result)) return [];
    if (!Array.isArray(result.panels)) return [];
    const cvars = result.panels.flatMap((panel) =>
      typeof panel === "object" &&
      panel !== null &&
      "candidateCvar90" in panel &&
      typeof panel.candidateCvar90 === "number"
        ? [panel.candidateCvar90]
        : [],
    );
    return cvars.length > 0
      ? [
          {
            candidateId,
            maxPanelCvar90: Math.max(...cvars),
            baselineDistance: candidateDistance(candidateId),
          },
        ]
      : [];
  });
  return tail.selectHpTailWinner(candidates, (leftId, rightId) =>
    tailCandidatesAreIndistinguishable(section, leftId, rightId, significance, tail),
  );
}

function tailCandidatesAreIndistinguishable(
  section: object,
  leftId: string,
  rightId: string,
  significance: typeof import("./significance-gate"),
  tail: typeof import("./min-ef-hp-tail"),
): boolean {
  const value = section as { records?: unknown[]; protocol?: { panels?: unknown } };
  const panelIds = Array.isArray(value.protocol?.panels)
    ? value.protocol.panels.filter((entry): entry is string => typeof entry === "string")
    : [];
  const records = (value.records ?? []).filter(isCompletedConfirmationTailRecord);
  if (panelIds.length === 0) throw new Error("Tail confirmation report has no panel contract.");
  const pairs = panelIds.map((panelId) => {
    const left = confirmationSeedSamples(records, leftId, panelId);
    const right = confirmationSeedSamples(records, rightId, panelId);
    const gated = significance.gatePairedSeeds(left, right);
    if (gated.status !== "completed") {
      throw new Error(`Tail candidate comparison is incomplete for ${panelId}.`);
    }
    return { panelId, left: gated.basePool, right: gated.candPool };
  });
  const rightVersusLeft = tail.evaluateHpTailGate(
    pairs.map((pair) => ({
      panelId: pair.panelId,
      baseline: pair.left,
      candidate: pair.right,
    })),
  );
  const leftVersusRight = tail.evaluateHpTailGate(
    pairs.map((pair) => ({
      panelId: pair.panelId,
      baseline: pair.right,
      candidate: pair.left,
    })),
  );
  return !rightVersusLeft.passed && !leftVersusRight.passed;
}

function isCompletedConfirmationTailRecord(value: unknown): value is CompletedTailRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "phase" in value &&
    value.phase === "confirmation" &&
    "status" in value &&
    value.status === "completed" &&
    "candidateId" in value &&
    typeof value.candidateId === "string" &&
    "panelId" in value &&
    typeof value.panelId === "string" &&
    "seed" in value &&
    typeof value.seed === "number" &&
    "runs" in value &&
    value.runs === 20_000 &&
    "completionRate" in value &&
    typeof value.completionRate === "number" &&
    "maxSupplyDebtDaysSamples" in value &&
    Array.isArray(value.maxSupplyDebtDaysSamples)
  );
}

function confirmationSeedSamples(
  records: readonly CompletedTailRecord[],
  candidateId: string,
  panelId: string,
) {
  return records
    .filter((record) => record.candidateId === candidateId && record.panelId === panelId)
    .sort((left, right) => left.seed - right.seed)
    .map((record) => ({
      seed: record.seed,
      completionRate: record.completionRate,
      samples: record.maxSupplyDebtDaysSamples,
    }));
}

function candidateDistance(candidateId: string): number {
  const match = candidateId.match(/^H([\d.]+)-p(\d+(?:\.\d+)?|inf)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const horizon = Number(match[1]);
  const norm = match[2] === "inf" ? Number.POSITIVE_INFINITY : Number(match[2]);
  return Math.abs(horizon - 0.75) + (Number.isFinite(norm) ? Math.abs(norm - 3) : 1000);
}

function koreanFindings(
  report: NonNullable<Awaited<ReturnType<typeof readHpStudyReport>>>,
): string {
  const summary = summarizeStudy(report);
  return `# Rust min-E[f] H/p 공동 최적화 연구\n\n- 생성 시각: ${report.generatedAt}\n- 기준점: \`${report.baselineVerification.candidateId}\`, tau=0\n- 범위: 연구 전용, 제품 채택 자동 승인 없음\n\n## 증거 계보\n\n| 자료 | 의미론 | 이번 판정에서의 역할 |\n| --- | --- | --- |\n| \`6dcb329\` availability 연구 | 과거 solver·재고 계약 | 역사적 선행 증거만 사용, 수치 합산 안 함 |\n| 현재 \`min-ef-hp-study\` v1 | raw pieces, 현재 WASM, min-E[f]→phase2 ladder | 현재 판정의 유일한 수치 근거 |\n\n## 기준선과 screening\n\n- [확인] Baseline 동치 검증: ${report.baselineVerification.status} (${report.baselineVerification.notes.join("; ")})\n- [확인] Root screening: ${report.screening.records.length}/${summary.screenExpected}\n- [확인] Shortlist ${report.screening.shortlistIds.length}개: ${report.screening.shortlistIds.map((id) => `\`${id}\``).join(", ")}\n- [확인] Root screening은 후보 축소용이며 사용자 체감 지연 분포가 아닙니다.\n\n## Exact interactive\n\n- [${report.exact.complete ? "확인" : "미검증"}] Terminal record: ${summary.exactTerminal}/${summary.exactExpected}\n- [확인] 완료 ${summary.exactCompleted}, solver failure ${summary.exactFailures}, checkpoint 대기 ${summary.exactIncomplete}\n- [확인] Hard-gate 결과: 통과 ${summary.exactPassed}, 탈락 ${summary.exactFailed}, 판정 불완전 ${summary.exactGateIncomplete}\n- [확인] Tail 진입 후보: ${report.exact.finalistIds.map((id) => `\`${id}\``).join(", ")}\n\n## Tail·D1·성능\n\n- [${report.tailRisk.status === "completed" ? "확인" : "미검증"}] Tail discovery 판정 ${summary.tailDiscoveryDecisions}건, 통과 ${summary.tailDiscoveryPassed}건, confirmation record ${summary.tailConfirmationRecords}건\n${summary.tailWorseningKo}- [확인] D1 snapshot${summary.d1Snapshot}; 후보 replay 판정 ${summary.d1DecisionCount}건\n- [확인] 독립 성능 record ${summary.performanceRecordCount}건\n- [추론] Tail discovery 통과 후보가 없어 D1 후보 replay와 성능 캠페인은 실행하지 않았습니다.\n- [추론] D1 이벤트는 반복 계산 이벤트이며 사용자 수나 실제 사용자 비율로 해석하지 않습니다.\n\n## 판정\n\n${report.candidateGrades.map((entry) => `- \`${entry.candidateId}\`: ${entry.grade}`).join("\n") || "- [미검증] 아직 전체 판정을 내릴 증거가 없습니다."}\n\n- [추론] 최종 상태: ${summary.finalStatus}\n- [추론] 선택 후보: \`${summary.selectedCandidateId}\`\n- [확인] 이 보고서는 runtime 상수 변경을 승인하지 않습니다.\n\n모든 필수 게이트가 끝나지 않았거나 baseline과 통계적으로 구분되는 이득이 없으면 현재 제품값 H=0.75, p=3을 유지합니다.\n`;
}

function englishFindings(
  report: NonNullable<Awaited<ReturnType<typeof readHpStudyReport>>>,
): string {
  const summary = summarizeStudy(report);
  return `# Rust min-E[f] Joint H/p Study\n\n- Generated: ${report.generatedAt}\n- Baseline: \`${report.baselineVerification.candidateId}\`, tau=0\n- Scope: research only; no automatic product-adoption authority\n\n## Evidence Lineage\n\n| Evidence | Semantics | Role in this decision |\n| --- | --- | --- |\n| \`6dcb329\` availability study | historical solver and stock contract | prior evidence only; numeric results are not pooled |\n| current \`min-ef-hp-study\` v1 | raw pieces, current WASM, min-E[f] to phase2 ladder | sole numeric basis for the current decision |\n\n## Baseline And Screening\n\n- [Confirmed] Baseline equivalence: ${report.baselineVerification.status} (${report.baselineVerification.notes.join("; ")})\n- [Confirmed] Root screening: ${report.screening.records.length}/${summary.screenExpected}\n- [Confirmed] ${report.screening.shortlistIds.length} shortlisted candidates: ${report.screening.shortlistIds.map((id) => `\`${id}\``).join(", ")}\n- [Confirmed] Root-screen latency is candidate-screening evidence, not a user-experience distribution.\n\n## Exact Interactive\n\n- [${report.exact.complete ? "Confirmed" : "Unverified"}] Terminal records: ${summary.exactTerminal}/${summary.exactExpected}\n- [Confirmed] completed ${summary.exactCompleted}, solver failures ${summary.exactFailures}, checkpoint pending ${summary.exactIncomplete}\n- [Confirmed] hard gates: ${summary.exactPassed} passed, ${summary.exactFailed} failed, ${summary.exactGateIncomplete} incomplete\n- [Confirmed] Tail entrants: ${report.exact.finalistIds.map((id) => `\`${id}\``).join(", ")}\n\n## Tail, D1, And Performance\n\n- [${report.tailRisk.status === "completed" ? "Confirmed" : "Unverified"}] ${summary.tailDiscoveryDecisions} tail discovery decision(s), ${summary.tailDiscoveryPassed} passed, ${summary.tailConfirmationRecords} confirmation record(s)\n${summary.tailWorseningEn}- [Confirmed] D1 snapshot${summary.d1Snapshot}; ${summary.d1DecisionCount} candidate replay decision(s)\n- [Confirmed] ${summary.performanceRecordCount} independent performance record(s)\n- [Inference] No tail-discovery challenger passed, so candidate D1 replay and performance campaigns were skipped.\n- [Inference] D1 events are repeated calculation events, not unique users or user-frequency estimates.\n\n## Decision\n\n${report.candidateGrades.map((entry) => `- \`${entry.candidateId}\`: ${entry.grade}`).join("\n") || "- [Unverified] Evidence is not complete enough for a final grade."}\n\n- [Inference] Final status: ${summary.finalStatus}\n- [Inference] Selected candidate: \`${summary.selectedCandidateId}\`\n- [Confirmed] This report does not authorize a runtime-constant change.\n\nKeep H=0.75, p=3 whenever a required gate is incomplete or no benefit is statistically distinguishable from baseline.\n`;
}

function summarizeStudy(report: NonNullable<Awaited<ReturnType<typeof readHpStudyReport>>>) {
  const exactCompleted = report.exact.records.filter(
    (record) => record.evaluation.status === "completed",
  ).length;
  const exactFailures = report.exact.records.filter(
    (record) => record.evaluation.status === "solver_failure",
  ).length;
  const exactIncomplete = report.exact.records.filter(
    (record) => record.evaluation.status === "verification_incomplete",
  ).length;
  const finalDecision = (report as HpStudyWithDecision).finalDecision;
  const d1 = report.d1Robustness as typeof report.d1Robustness & {
    snapshot?: { eventCount?: unknown; diagnosticVersion?: unknown };
  };
  const d1Snapshot = d1.snapshot
    ? ` (diagnostic v${String(d1.snapshot.diagnosticVersion)}, ${String(d1.snapshot.eventCount)} events)`
    : "";
  const tailSection = report.tailRisk as typeof report.tailRisk & {
    records?: unknown[];
    discoveryDecisions?: Array<{
      candidateId?: unknown;
      passed?: unknown;
      result?: {
        panels?: Array<{
          panelId?: unknown;
          baselineCvar90?: unknown;
          candidateCvar90?: unknown;
          pointImprovement?: unknown;
          worseningAdjusted?: unknown;
        }>;
      } | null;
    }>;
  };
  const discoveryDecisions = tailSection.discoveryDecisions ?? [];
  const worsening = discoveryDecisions
    .flatMap((decision) =>
      (decision.result?.panels ?? []).map((panel) => ({
        candidateId: decision.candidateId,
        panel,
      })),
    )
    .find((entry) => entry.panel.worseningAdjusted === true);
  const worseningCandidate = String(worsening?.candidateId ?? "none");
  const worseningPanel = String(worsening?.panel.panelId ?? "none");
  const baselineCvar = Number(worsening?.panel.baselineCvar90);
  const candidateCvar = Number(worsening?.panel.candidateCvar90);
  const pointImprovement = Number(worsening?.panel.pointImprovement);
  const tailWorseningKo = worsening
    ? `- [확인] \`${worseningCandidate}\`는 \`${worseningPanel}\`에서 CVaR90 ${baselineCvar.toFixed(4)}→${candidateCvar.toFixed(4)}일, 개선량 ${pointImprovement.toFixed(4)}일로 Holm 보정 후 유의하게 악화했습니다.\n`
    : "";
  const tailWorseningEn = worsening
    ? `- [Confirmed] \`${worseningCandidate}\` changed \`${worseningPanel}\` CVaR90 from ${baselineCvar.toFixed(4)} to ${candidateCvar.toFixed(4)} days (improvement ${pointImprovement.toFixed(4)} days), a Holm-adjusted significant regression.\n`
    : "";
  const d1Decisions = (d1 as { decisions?: unknown[] }).decisions ?? [];
  return {
    screenExpected: report.options.candidates.length * report.options.scenarioIds.length,
    exactExpected: report.screening.shortlistIds.length * report.options.exactScenarioIds.length,
    exactTerminal: exactCompleted + exactFailures,
    exactCompleted,
    exactFailures,
    exactIncomplete,
    exactPassed: report.exact.gates.filter((entry) => entry.gate.status === "passed").length,
    exactFailed: report.exact.gates.filter((entry) => entry.gate.status === "failed").length,
    exactGateIncomplete: report.exact.gates.filter(
      (entry) => entry.gate.status === "verification_incomplete",
    ).length,
    tailDiscoveryDecisions: discoveryDecisions.length,
    tailDiscoveryPassed: discoveryDecisions.filter((entry) => entry.passed === true).length,
    tailConfirmationRecords: (tailSection.records ?? []).filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "phase" in entry &&
        entry.phase === "confirmation",
    ).length,
    tailWorseningKo,
    tailWorseningEn,
    d1Snapshot,
    d1DecisionCount: d1Decisions.length,
    performanceRecordCount: report.performance.records.length,
    finalStatus: finalDecision.status,
    selectedCandidateId: finalDecision.selectedCandidateId,
  };
}
