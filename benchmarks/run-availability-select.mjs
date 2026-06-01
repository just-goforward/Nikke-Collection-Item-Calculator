// Selection / decision stage (the capstone the original progress never reached).
//
// Consumes the deep-evaluation JSON (slice or single-shot) and produces:
//   - per-candidate 2D coordinates: x = worst exact interactive-replan P-loss vs A,
//     y = journey-demand CVaR90(max supplyDebtDays) on completion-sufficient panels,
//   - finite-stock guardrail deltas vs A (residual / depletion / autonomy),
//   - the 2D Pareto frontier,
//   - per-stage acceptance contracts (확률우선 / 균형 / 보존) with ΔP_budget,
//   - output-monotonicity check across the 3 chosen points,
//   - post-hoc stage labels,
//   - a null-result determination (improved-default-available / 3-stage / 2-stage / keep-A /
//     insufficient-evidence). "improved-default-available" means a candidate strictly dominates A
//     (>= A probability everywhere, significantly better supplyDebt, guardrails not degraded) —
//     a free supply win via the horizon lever H, so the trade-off slider premise does not hold,
//   - a preservation-escalation suggestion when no p=3 보존 point qualifies,
//   - a Korean decision report (markdown) + machine-readable JSON.
//
// This stage performs NO solving; it is a transparent, deterministic decision over already
// collected evidence. It degrades gracefully to "insufficient-evidence" on partial data.

import { mkdir, readFile, writeFile } from "node:fs/promises";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SLICE_FILE = new URL("./results/availability-deep-slice.json", import.meta.url);
const SINGLE_FILE = new URL("./results/availability-deep.json", import.meta.url);
const SIGNIFICANCE_FILE = new URL("./results/availability-significance.json", import.meta.url);
const JSON_OUTPUT = new URL("./results/availability-selection.json", import.meta.url);
const REPORT_OUTPUT = new URL("./results/availability-selection-report.ko.md", import.meta.url);

const BASELINE_ID = "tau0.01-h0.5-p3";
const NO_LOSS_EPSILON = 1e-9;
const STRICT_EPSILON = 1e-9;

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Acceptance / guardrail thresholds (pre-registered; env-overridable).
const deltaPBudget = parseNumber(process.env.AVAILABILITY_SELECT_DELTA_P_BUDGET, 0.005);
const depletionTolerance = parseNumber(process.env.AVAILABILITY_SELECT_DEPLETION_TOL, 0.01);
const residualRelTolerance = parseNumber(process.env.AVAILABILITY_SELECT_RESIDUAL_REL_TOL, 0.05);
const autonomyRelTolerance = parseNumber(process.env.AVAILABILITY_SELECT_AUTONOMY_REL_TOL, 0.05);

const KITS = ["blue", "purple", "yellow"];

async function loadReport() {
  for (const file of [SLICE_FILE, SINGLE_FILE]) {
    try {
      return { report: JSON.parse(await readFile(file, "utf8")), source: file.pathname };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "No deep-evaluation results found. Run bench:availability-deep:slice (or bench:availability-deep) first.",
  );
}

async function loadSignificance() {
  try {
    const report = JSON.parse(await readFile(SIGNIFICANCE_FILE, "utf8"));
    const byId = new Map((report.candidates || []).map((c) => [c.candidateId, c]));
    return { available: true, report, byId };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { available: false, report: null, byId: new Map() };
  }
}

function mean(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Number.NaN;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function minKit(stock) {
  if (!stock) return Number.NaN;
  return Math.min(...KITS.map((kit) => Number(stock[kit])));
}

// --- finite-stock guardrails: average per (candidate, scenario) across seeds -----------------
function aggregateFiniteTail(finiteStockTail) {
  const byKey = new Map();
  for (const entry of finiteStockTail || []) {
    if (entry.status !== "completed" || !entry.summary) continue;
    const key = `${entry.modelId}|${entry.scenario}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry.summary);
  }
  const result = new Map(); // modelId -> Map(scenario -> aggregated guardrail)
  for (const [key, summaries] of byKey) {
    const [modelId, scenario] = key.split("|");
    if (!result.has(modelId)) result.set(modelId, new Map());
    result.get(modelId).set(scenario, {
      residualP05Min: mean(summaries.map((s) => minKit(s.residualP05))),
      depletionProbability: mean(summaries.map((s) => s.depletionProbability)),
      autonomyDaysP05: mean(summaries.map((s) => s.autonomyDaysP05)),
      seeds: summaries.length,
    });
  }
  return result;
}

// --- exact P-loss gate per candidate ---------------------------------------------------------
function aggregateExact(exactResults) {
  const byCandidate = new Map();
  for (const entry of exactResults || []) {
    if (!byCandidate.has(entry.modelId)) {
      byCandidate.set(entry.modelId, { completed: [], incomplete: [] });
    }
    const bucket = byCandidate.get(entry.modelId);
    if (entry.status === "completed") bucket.completed.push(entry);
    else bucket.incomplete.push(entry);
  }
  return byCandidate;
}

function sumGateEvidence(completedEntries) {
  let eligibleEmptyCount = 0;
  let internalViolationCount = 0;
  let boundaryViolationCount = 0;
  for (const entry of completedEntries) {
    const evidence = entry.gateEvidence || {};
    eligibleEmptyCount += Number(evidence.eligibleEmptyCount ?? 0);
    internalViolationCount += Number(
      evidence.internalViolationCount ?? evidence.violationCount ?? 0,
    );
    boundaryViolationCount += Number(evidence.boundaryViolationCount ?? 0);
  }
  return { eligibleEmptyCount, internalViolationCount, boundaryViolationCount };
}

function buildCandidate(
  modelId,
  exactByCandidate,
  finiteByCandidate,
  journeyByCandidate,
  gateScenarioIds,
) {
  const exact = exactByCandidate.get(modelId) || { completed: [], incomplete: [] };
  const losses = exact.completed
    .map((entry) => Number(entry.exactLossVsA))
    .filter((value) => Number.isFinite(value));
  const relativeLosses = exact.completed
    .map((entry) => Number(entry.relativeLossVsA))
    .filter((value) => Number.isFinite(value));
  const judgedScenarioIds = new Set(
    exact.completed.filter((e) => Number.isFinite(Number(e.exactLossVsA))).map((e) => e.scenario),
  );
  // A is judged by completion alone (its own loss is 0 by definition).
  if (modelId === BASELINE_ID) {
    for (const entry of exact.completed) judgedScenarioIds.add(entry.scenario);
  }
  const gateComplete = gateScenarioIds.every((id) => judgedScenarioIds.has(id));
  const incompleteReasons = exact.incomplete.map((e) => `${e.scenario}:${e.reason || e.status}`);

  const journey = journeyByCandidate.get(modelId) || null;
  const supplyDebt =
    journey && Number.isFinite(Number(journey.maxPanelSupplyDebtCvar90))
      ? Number(journey.maxPanelSupplyDebtCvar90)
      : null;

  return {
    modelId,
    worstExactLoss: modelId === BASELINE_ID ? 0 : losses.length ? Math.max(...losses) : null,
    worstRelativeLoss:
      modelId === BASELINE_ID ? 0 : relativeLosses.length ? Math.max(...relativeLosses) : null,
    gateComplete,
    gateJudgedCount: judgedScenarioIds.size,
    gateTotal: gateScenarioIds.length,
    incompleteReasons,
    gateEvidence: sumGateEvidence(exact.completed),
    supplyDebt,
    supplyDebtJudgeable: supplyDebt !== null,
    finiteByScenario: finiteByCandidate.get(modelId) || new Map(),
  };
}

// guardrail comparison vs A, per scenario; returns degradation + per-scenario improvement flags
function guardrailComparison(candidate, baseline, gateScenarioIds) {
  let degraded = false;
  const degradations = [];
  let anyRiskStratumBetter = false;
  for (const scenario of gateScenarioIds) {
    const c = candidate.finiteByScenario.get(scenario);
    const a = baseline.finiteByScenario.get(scenario);
    if (!c || !a) continue;
    // depletion must not increase beyond tolerance
    if (Number.isFinite(c.depletionProbability) && Number.isFinite(a.depletionProbability)) {
      if (c.depletionProbability > a.depletionProbability + depletionTolerance) {
        degraded = true;
        degradations.push(
          `${scenario}: depletion ${a.depletionProbability.toFixed(4)}→${c.depletionProbability.toFixed(4)}`,
        );
      }
    }
    // residualP05 (worst kit) must not drop relatively beyond tolerance
    if (
      Number.isFinite(c.residualP05Min) &&
      Number.isFinite(a.residualP05Min) &&
      a.residualP05Min > 0
    ) {
      if (c.residualP05Min < a.residualP05Min * (1 - residualRelTolerance)) {
        degraded = true;
        degradations.push(
          `${scenario}: residualP05 ${a.residualP05Min.toFixed(1)}→${c.residualP05Min.toFixed(1)}`,
        );
      }
    }
    // autonomy p05 must not drop relatively beyond tolerance
    if (
      Number.isFinite(c.autonomyDaysP05) &&
      Number.isFinite(a.autonomyDaysP05) &&
      a.autonomyDaysP05 > 0
    ) {
      if (c.autonomyDaysP05 < a.autonomyDaysP05 * (1 - autonomyRelTolerance)) {
        degraded = true;
        degradations.push(
          `${scenario}: autonomyP05 ${a.autonomyDaysP05.toFixed(2)}→${c.autonomyDaysP05.toFixed(2)}`,
        );
      }
      if (c.autonomyDaysP05 > a.autonomyDaysP05 + STRICT_EPSILON) anyRiskStratumBetter = true;
    }
    if (
      Number.isFinite(c.depletionProbability) &&
      Number.isFinite(a.depletionProbability) &&
      c.depletionProbability < a.depletionProbability - STRICT_EPSILON
    ) {
      anyRiskStratumBetter = true;
    }
  }
  return { degraded, degradations, anyRiskStratumBetter };
}

function paretoFrontier(points) {
  // minimize both x (loss) and y (supplyDebt)
  return points.filter((p) => {
    return !points.some(
      (q) =>
        q.modelId !== p.modelId &&
        q.x <= p.x + STRICT_EPSILON &&
        q.y <= p.y + STRICT_EPSILON &&
        (q.x < p.x - STRICT_EPSILON || q.y < p.y - STRICT_EPSILON),
    );
  });
}

function fmt(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

async function main() {
  const { report, source } = await loadReport();
  const significance = await loadSignificance();
  const candidateIds = Array.from(
    new Set([
      ...(report.exactResults || []).map((e) => e.modelId),
      ...(report.journeyDemand || []).map((j) => j.candidateId),
    ]),
  );
  const gateScenarioIds = Array.from(new Set((report.exactResults || []).map((e) => e.scenario)));

  const exactByCandidate = aggregateExact(report.exactResults);
  const finiteByCandidate = aggregateFiniteTail(report.finiteStockTail);
  const journeyByCandidate = new Map((report.journeyDemand || []).map((j) => [j.candidateId, j]));

  const candidates = candidateIds.map((id) =>
    buildCandidate(id, exactByCandidate, finiteByCandidate, journeyByCandidate, gateScenarioIds),
  );
  const baseline = candidates.find((c) => c.modelId === BASELINE_ID);

  // assemble the report scaffold even when evidence is insufficient
  const out = {
    kind: "availability-selection",
    version: 1,
    generatedAt: new Date().toISOString(),
    source,
    deltaPBudget,
    guardrailTolerances: { depletionTolerance, residualRelTolerance, autonomyRelTolerance },
    baselineId: BASELINE_ID,
    significanceAvailable: significance.available,
    gateScenarioIds,
    candidates: candidates.map((c) => ({
      modelId: c.modelId,
      worstExactLoss: c.worstExactLoss,
      worstRelativeLoss: c.worstRelativeLoss,
      supplyDebtCvar90: c.supplyDebt,
      supplyDebtSignificantImprovement:
        significance.byId.get(c.modelId)?.significantImprovement ?? null,
      gateComplete: c.gateComplete,
      gateJudged: `${c.gateJudgedCount}/${c.gateTotal}`,
      incompleteReasons: c.incompleteReasons,
      gateEvidence: c.gateEvidence,
    })),
  };

  if (!baseline || !baseline.gateComplete || !baseline.supplyDebtJudgeable) {
    out.outcome = "insufficient-evidence";
    out.reason = !baseline
      ? "Baseline A absent from results."
      : !baseline.gateComplete
        ? `Baseline A gate incomplete (${baseline.gateJudgedCount}/${baseline.gateTotal}; ${baseline.incompleteReasons.join(", ")}).`
        : "Baseline A journey supplyDebt unjudgeable (no completion-sufficient panel).";
    await writeOutputs(out, report);
    return out;
  }

  // judgeable non-baseline candidates: complete gate, no unintended fallback, supplyDebt available
  const judgeable = candidates.filter(
    (c) =>
      c.modelId !== BASELINE_ID &&
      c.gateComplete &&
      c.supplyDebtJudgeable &&
      c.gateEvidence.eligibleEmptyCount === 0,
  );

  for (const c of judgeable) {
    const guard = guardrailComparison(c, baseline, gateScenarioIds);
    c.guard = guard;
    c.noLoss = c.worstExactLoss <= NO_LOSS_EPSILON;
    c.boundedLoss = c.worstExactLoss <= deltaPBudget + STRICT_EPSILON;
    c.tailStrictlyBetter = c.supplyDebt < baseline.supplyDebt - STRICT_EPSILON;
    const sig = significance.byId.get(c.modelId);
    c.significance = sig || null;
    // Preferred 보존 criterion: a STATISTICALLY significant tail improvement (paired bootstrap +
    // Holm). Fall back to the raw point estimate only when no significance evidence exists — in
    // that case the preservation conclusion is provisional (flagged in the report).
    c.tailSignificantlyBetter = significance.available
      ? Boolean(sig?.significantImprovement)
      : c.tailStrictlyBetter;
  }

  const paretoPoints = paretoFrontier([
    { modelId: baseline.modelId, x: 0, y: baseline.supplyDebt },
    ...judgeable.map((c) => ({ modelId: c.modelId, x: c.worstExactLoss, y: c.supplyDebt })),
  ]).map((p) => p.modelId);
  out.paretoFrontier = paretoPoints;

  // --- stage assignment ---------------------------------------------------------------------
  // 균형 = A.
  const balanced = baseline;

  // 확률우선: no P-loss, guardrails OK; maximize probability (minimize loss), tie-break lowest τ.
  const probabilityCandidates = judgeable
    .filter((c) => c.noLoss && !c.guard.degraded)
    .sort(
      (a, b) =>
        a.worstExactLoss - b.worstExactLoss ||
        tauOf(a.modelId) - tauOf(b.modelId) ||
        a.supplyDebt - b.supplyDebt,
    );
  // probability-priority point is only meaningful if it strictly beats A on probability (P>A,
  // i.e., negative loss) — otherwise the probability end collapses onto 균형 (A).
  const probabilityFirst =
    probabilityCandidates.find((c) => c.worstExactLoss < -NO_LOSS_EPSILON) || null;

  // 보존: bounded loss, strictly better tail + >=1 risk stratum better, guardrails OK; maximize
  // conservation (minimize supplyDebt), tie-break lowest loss.
  const preservationCandidates = judgeable
    .filter(
      (c) =>
        c.boundedLoss &&
        c.worstExactLoss > NO_LOSS_EPSILON &&
        !c.guard.degraded &&
        c.tailSignificantlyBetter &&
        c.guard.anyRiskStratumBetter,
    )
    .sort((a, b) => a.supplyDebt - b.supplyDebt || a.worstExactLoss - b.worstExactLoss);
  const preservation = preservationCandidates[0] || null;

  // --- A-domination -------------------------------------------------------------------------
  // Candidates that are at least as good as A on probability EVERYWHERE (no meaningful P-loss)
  // AND significantly better on supplyDebt AND not guardrail-degraded AND strictly better on >=1
  // guardrail strictly DOMINATE A: a free supply+risk improvement at no probability cost. The
  // 확률우선/보존 trade-off contracts cannot express this (they need P strictly > A or strictly < A,
  // i.e. a non-zero loss), so without this check a strict improvement over A is mis-reported as
  // "keep-A-only". The supply lever here is the horizon factor H, not the probability tolerance τ.
  const dominatorsOfA = judgeable
    .filter(
      (c) =>
        c.noLoss && !c.guard.degraded && c.guard.anyRiskStratumBetter && c.tailSignificantlyBetter,
    )
    .sort((a, b) => a.supplyDebt - b.supplyDebt || a.worstExactLoss - b.worstExactLoss);
  const improvedDefault = dominatorsOfA[0] || null;

  // --- monotonicity across chosen points ----------------------------------------------------
  const chosen = [];
  if (probabilityFirst) chosen.push({ stage: "확률우선", c: probabilityFirst });
  chosen.push({ stage: "균형", c: balanced });
  if (preservation) chosen.push({ stage: "보존", c: preservation });

  const lossOf = (c) => (c.modelId === BASELINE_ID ? 0 : c.worstExactLoss);
  const debtOf = (c) => c.supplyDebt;
  let monotone = true;
  for (let i = 1; i < chosen.length; i += 1) {
    const prev = chosen[i - 1].c;
    const cur = chosen[i].c;
    // exact P non-increasing => loss non-decreasing; tail risk strictly improving => debt decreasing
    if (lossOf(cur) < lossOf(prev) - STRICT_EPSILON) monotone = false;
    if (debtOf(cur) > debtOf(prev) + STRICT_EPSILON) monotone = false;
  }

  // --- outcome ------------------------------------------------------------------------------
  // A strict improvement over A (improvedDefault) takes precedence: the slider's probability↔supply
  // trade-off premise does not hold when supply can be improved for free, so the honest headline is
  // "update the default", not a trade-off slider.
  let outcome;
  if (improvedDefault) outcome = "improved-default-available";
  else if (probabilityFirst && preservation && monotone) outcome = "3-stage";
  else if (probabilityFirst && preservation && !monotone) outcome = "non-monotone-3-candidates";
  else if (!probabilityFirst && preservation) outcome = "2-stage:balanced+preservation";
  else if (probabilityFirst && !preservation) outcome = "2-stage:probability+balanced";
  else outcome = "keep-A-only";

  // preservation escalation (correction #6): if no 보존 found and the evaluated set was all p=3,
  // suggest escalating with p in {4, Infinity}. Not needed when a free improvement already exists.
  const evaluatedNormPowers = new Set(judgeable.map((c) => pOf(c.modelId)));
  const preservationEscalationSuggested =
    !preservation &&
    !improvedDefault &&
    evaluatedNormPowers.size > 0 &&
    [...evaluatedNormPowers].every((p) => p === 3);

  out.stages = chosen.map(({ stage, c }) => ({
    stage,
    modelId: c.modelId,
    worstExactLoss: lossOf(c),
    worstRelativeLoss: c.modelId === BASELINE_ID ? 0 : c.worstRelativeLoss,
    supplyDebtCvar90: c.supplyDebt,
    tailSignificantImprovement:
      c.modelId === BASELINE_ID ? null : Boolean(c.tailSignificantlyBetter),
    guardrailDegraded: c.guard ? c.guard.degraded : false,
    guardrailDegradations: c.guard ? c.guard.degradations : [],
    riskStratumBetter: c.guard ? c.guard.anyRiskStratumBetter : null,
  }));
  out.monotone = monotone;
  out.outcome = outcome;
  out.baselineSupplyDebt = baseline.supplyDebt;
  // Strict improvement over A (dominates on probability + supply + >=1 guardrail). When present,
  // the recommended action is to replace the default A with improvedDefault.
  out.improvedDefaultAvailable = Boolean(improvedDefault);
  out.improvedDefault = improvedDefault
    ? {
        modelId: improvedDefault.modelId,
        worstExactLoss: improvedDefault.worstExactLoss,
        supplyDebtCvar90: improvedDefault.supplyDebt,
        supplyDebtVsA: improvedDefault.supplyDebt - baseline.supplyDebt,
        tailSignificantImprovement: Boolean(improvedDefault.tailSignificantlyBetter),
        riskStratumBetter: improvedDefault.guard.anyRiskStratumBetter,
        provisional: !significance.available,
      }
    : null;
  out.dominatorsOfA = dominatorsOfA.map((c) => c.modelId);
  // If a 보존 point was chosen without significance evidence, the conclusion is provisional.
  out.preservationProvisional = Boolean(preservation) && !significance.available;
  out.preservationEscalationSuggested = preservationEscalationSuggested;
  out.diagnostics = {
    judgeableCount: judgeable.length,
    probabilityCandidateCount: probabilityCandidates.length,
    preservationCandidateCount: preservationCandidates.length,
    dominatorCount: dominatorsOfA.length,
    droppedForFallback: candidates
      .filter((c) => c.modelId !== BASELINE_ID && c.gateEvidence.eligibleEmptyCount > 0)
      .map((c) => c.modelId),
  };

  await writeOutputs(out, report);
  return out;
}

function tauOf(modelId) {
  const match = modelId.match(/tau([\d.]+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}
function pOf(modelId) {
  const match = modelId.match(/-p(inf|\d+)$/);
  if (!match) return Number.NaN;
  return match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
}

function renderReport(out) {
  const lines = [];
  lines.push("# Availability 슬라이더 선정 결과 (자동 생성)");
  lines.push("");
  lines.push(`- 생성 시각: ${out.generatedAt}`);
  lines.push(`- 입력: \`${out.source}\``);
  lines.push(`- ΔP_budget(절대 P 손실 허용): ${out.deltaPBudget}`);
  lines.push(`- 게이트 시나리오: ${out.gateScenarioIds.join(", ")}`);
  lines.push("");
  lines.push(`## 결론: \`${out.outcome}\``);
  if (out.improvedDefault) {
    const d = out.improvedDefault;
    lines.push("");
    lines.push(
      `- ⭐ **A는 지배됨 — 기본값 교체 권장**: \`${d.modelId}\`가 **확률 손실 없이**` +
        `(최악 P손실 ${fmt(d.worstExactLoss)}) supplyDebt를 ${fmt(out.baselineSupplyDebt ?? null, 1)}→${fmt(d.supplyDebtCvar90, 1)}` +
        ` (${fmt(d.supplyDebtVsA, 1)}) 개선하고 위험군(고갈 등) ≥1개 개선, guardrail 비악화.` +
        `${d.tailSignificantImprovement && !d.provisional ? " supplyDebt 개선은 **유의(統計的, paired bootstrap+Holm)**." : ""}` +
        `${d.provisional ? " (supplyDebt 개선은 현재 **점추정** — significance 실행 후 유의성 확정)." : ""}`,
    );
    lines.push(
      `  - 이는 확률↔공급 **trade-off가 아니라 공짜 개선**입니다(레버 = horizon H, not τ). ` +
        `지배 후보 전체: ${out.dominatorsOfA.map((id) => `\`${id}\``).join(", ")}.`,
    );
    lines.push("");
  }
  if (out.reason) lines.push(`- 사유: ${out.reason}`);
  if (out.monotone !== undefined) lines.push(`- 출력 단조성: ${out.monotone ? "충족" : "위반"}`);
  lines.push(
    `- 유의성 증거: ${out.significanceAvailable ? "있음(보존 = paired bootstrap + Holm 유의 개선)" : "없음(보존 판정은 점추정 — 잠정)"}`,
  );
  if (out.preservationProvisional) {
    lines.push(
      "- ⚠ 보존 단계가 **유의성 검정 없이 점추정**으로 선택됨. `bench:availability-significance` 실행 후 select 재실행 권장.",
    );
  }
  if (out.preservationEscalationSuggested) {
    lines.push(
      "- 보존 단계 미성립 + 평가셋이 전부 p=3 → p∈{4,∞} escalation probe 권장: " +
        "`AVAILABILITY_DEEP_CANDIDATES=...,tau0.02-h0-p4,tau0.02-h0-pinf`로 deep 재실행.",
    );
  }
  lines.push("");
  if (out.stages) {
    lines.push("## 단계별 후보");
    lines.push("");
    lines.push(
      "| 단계 | 후보 | 최악 exact P손실(vs A) | 상대손실 | supplyDebt CVaR90 | tail 유의개선 | guardrail 악화 |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const s of out.stages) {
      const sig =
        s.tailSignificantImprovement === null
          ? "-"
          : s.tailSignificantImprovement
            ? "예"
            : "아니오";
      lines.push(
        `| ${s.stage} | \`${s.modelId}\` | ${fmt(s.worstExactLoss)} | ${fmt(s.worstRelativeLoss)} | ${fmt(s.supplyDebtCvar90, 3)} | ${sig} | ${s.guardrailDegraded ? "예(" + s.guardrailDegradations.join("; ") + ")" : "아니오"} |`,
      );
    }
    lines.push("");
  }
  if (out.paretoFrontier) {
    lines.push(`## 2D Pareto 전선 (x=exact P손실, y=supplyDebt)`);
    lines.push("");
    lines.push(out.paretoFrontier.map((id) => `\`${id}\``).join(", "));
    lines.push("");
  }
  lines.push("## 전체 후보 좌표");
  lines.push("");
  lines.push("| 후보 | exact P손실 | supplyDebt CVaR90 | gate 판정 | fallback(eligibleEmpty) |");
  lines.push("|---|---|---|---|---|");
  for (const c of out.candidates) {
    lines.push(
      `| \`${c.modelId}\` | ${fmt(c.worstExactLoss)} | ${fmt(c.supplyDebtCvar90, 3)} | ${c.gateJudged}${c.gateComplete ? "" : " (불완전)"} | ${c.gateEvidence.eligibleEmptyCount} |`,
    );
  }
  lines.push("");
  lines.push(
    "> supplyDebt는 완주충분 journey panel에서만 측정됩니다(희소 시나리오의 절단 소비 아님).",
  );
  lines.push("> exact P 손실은 차단 게이트이며 MC fallback이 없습니다(timeout=판정불가).");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function writeOutputs(out, _report) {
  await mkdir(RESULTS_DIRECTORY, { recursive: true });
  await writeFile(JSON_OUTPUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  await writeFile(REPORT_OUTPUT, renderReport(out), "utf8");
}

const result = await main();
console.log(
  JSON.stringify(
    {
      kind: result.kind,
      outcome: result.outcome,
      monotone: result.monotone ?? null,
      stages: (result.stages || []).map((s) => ({ stage: s.stage, modelId: s.modelId })),
      paretoFrontier: result.paretoFrontier || [],
      preservationEscalationSuggested: result.preservationEscalationSuggested ?? null,
      report: REPORT_OUTPUT.pathname,
      json: JSON_OUTPUT.pathname,
    },
    null,
    2,
  ),
);
