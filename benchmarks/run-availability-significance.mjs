// Significance step (plan §4 / §7): CRN paired bootstrap + Holm-Bonferroni for the supplyDebt
// y-axis, so the 보존 contract's "strictly better tail" means a STATISTICALLY significant
// improvement, not a point-estimate that could be noise.
//
// Design: this is a standalone pass that does NOT touch the deep runner's checkpoint logic.
// It reads the deep results, selects only the 보존 CONTENDERS (candidates whose point supplyDebt
// is already below A and whose exact P-loss is within ΔP_budget), and re-collects ONLY their
// journey-panel trajectories (plus A) in a single process so the per-run arrays are paired in
// memory. Only contenders are re-run, so the cost is bounded. Output: availability-significance.json,
// consumed by run-availability-select.mjs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SLICE_FILE = new URL("./results/availability-deep-slice.json", import.meta.url);
const SINGLE_FILE = new URL("./results/availability-deep.json", import.meta.url);
const OUTPUT_FILE = new URL("./results/availability-significance.json", import.meta.url);

const BASELINE_ID = "tau0.01-h0.5-p3";
const EPS = 1e-9;

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

const resamples = parsePositiveInteger(process.env.AVAILABILITY_SIG_RESAMPLES, 10_000);
const confidence = parseNumber(process.env.AVAILABILITY_SIG_CONFIDENCE, 0.95);
const alpha = parseNumber(process.env.AVAILABILITY_SIG_ALPHA, 0.05);
const cvarAlpha = parseNumber(process.env.AVAILABILITY_SIG_CVAR_ALPHA, 0.9);
const bootstrapSeed = parsePositiveInteger(process.env.AVAILABILITY_SIG_SEED, 20260505);
const deltaPBudget = parseNumber(process.env.AVAILABILITY_SELECT_DELTA_P_BUDGET, 0.005);
// Per-seed completion gate, matching the deep journey y-axis (aggregateJourneyDemand drops a
// (panel, seed) job whose completionRate < this). A seed under-completed by EITHER A or the
// candidate is dropped from BOTH arms so the paired-bootstrap CRN pairing stays intact.
const completionThreshold = parseNumber(process.env.AVAILABILITY_SIG_COMPLETION_THRESHOLD, 0.995);
// Per re-collection journey-job budget. Journey panels are cache-fill dominated (~150-750s+ per
// job, see availability-journey-calibration.json), so the default must be generous or the
// baseline re-collection times out and every contender reads as judgement_incomplete.
const trajectoryBudgetMs = parsePositiveInteger(
  process.env.AVAILABILITY_SIG_TRAJECTORY_BUDGET_MS,
  1_200_000,
);

async function loadDeep() {
  for (const file of [SLICE_FILE, SINGLE_FILE]) {
    try {
      return { report: JSON.parse(await readFile(file, "utf8")), source: file.pathname };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("No deep-evaluation results found. Run the deep stage first.");
}

function pointSupplyDebt(report, modelId) {
  const entry = (report.journeyDemand || []).find((j) => j.candidateId === modelId);
  const value = entry ? Number(entry.maxPanelSupplyDebtCvar90) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function worstExactLoss(report, modelId) {
  if (modelId === BASELINE_ID) return 0;
  const losses = (report.exactResults || [])
    .filter((e) => e.modelId === modelId && e.status === "completed")
    .map((e) => Number(e.exactLossVsA))
    .filter((value) => Number.isFinite(value));
  return losses.length ? Math.max(...losses) : null;
}

function readConfig(report) {
  const cfg = report.config || report.options || {};
  return {
    journeyPanelIds: cfg.journeyPanelIds || ["R0-balanced300", "SR0-balanced300"],
    seeds: cfg.seeds || [20260505, 20260506, 20260507, 20260508],
    runsPerSeed: parsePositiveInteger(cfg.runsPerSeed, 12_000),
  };
}

await mkdir(RESULTS_DIRECTORY, { recursive: true });
const { report, source } = await loadDeep();
const { journeyPanelIds, seeds, runsPerSeed } = readConfig(report);

// 보존 contenders: point supplyDebt strictly below A AND exact P-loss within ΔP_budget.
const aDebt = pointSupplyDebt(report, BASELINE_ID);
const allModelIds = Array.from(
  new Set([
    ...(report.journeyDemand || []).map((j) => j.candidateId),
    ...(report.exactResults || []).map((e) => e.modelId),
  ]),
);
const contenders = [];
if (aDebt !== null) {
  for (const modelId of allModelIds) {
    if (modelId === BASELINE_ID) continue;
    const debt = pointSupplyDebt(report, modelId);
    const loss = worstExactLoss(report, modelId);
    if (debt === null || loss === null) continue;
    if (debt < aDebt - EPS && loss <= deltaPBudget + EPS) contenders.push(modelId);
  }
}
// Diagnostic override: force specific candidate ids to be significance-tested even if the auto
// criterion would not pick them. Uses real re-collected trajectories (only the contender SET is
// overridden, not any measured value), so the verdict stays honest. Used to exercise/validate the
// integration path. e.g. AVAILABILITY_SIG_FORCE_CONTENDERS=tau0-h1-p3
const forcedContenders = (process.env.AVAILABILITY_SIG_FORCE_CONTENDERS || "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id && id !== BASELINE_ID && !contenders.includes(id));
for (const id of forcedContenders) contenders.push(id);

const baseOutput = {
  kind: "availability-significance",
  version: 1,
  generatedAt: new Date().toISOString(),
  source,
  baselineId: BASELINE_ID,
  journeyPanelIds,
  seeds,
  runsPerSeed,
  resamples,
  confidence,
  alpha,
  cvarAlpha,
  completionThreshold,
  baselinePointSupplyDebt: aDebt,
  deltaPBudget,
};

if (aDebt === null || contenders.length === 0) {
  const out = {
    ...baseOutput,
    contenders,
    candidates: [],
    note:
      aDebt === null
        ? "Baseline A journey supplyDebt is unjudgeable; cannot test improvement significance."
        : "No 보존 contender (no candidate has point supplyDebt below A within ΔP_budget). Nothing to test.",
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ kind: out.kind, contenders, note: out.note }, null, 2));
  process.exit(0);
}

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const journey = await server.ssrLoadModule("/benchmarks/scenarios/journey-panels.ts");
  const availability = await server.ssrLoadModule("/benchmarks/models/availability-grid.ts");
  const trajectory = await server.ssrLoadModule("/benchmarks/evaluator/trajectory.ts");
  const metrics = await server.ssrLoadModule("/benchmarks/metrics.ts");
  const stats = await server.ssrLoadModule("/benchmarks/tail-statistics.ts");
  const gate = await server.ssrLoadModule("/benchmarks/significance-gate.ts");

  const allCandidates = availability.buildAvailabilityGridCandidates({
    includePreservationProbes: true,
    includeSensitivityProbes: true,
  });
  const byId = new Map(allCandidates.map((c) => [c.id, c]));
  const cvar90 = (values) => metrics.cvarUpperTail(values, cvarAlpha);

  // Collect per-(model, panel) per-SEED arrays (kept separate, with each seed's completionRate, so
  // completion gating can pair seeds across A and the candidate before pooling — matching the deep
  // journey gate without breaking the paired-bootstrap CRN structure).
  function collectPanelArray(modelId, panel) {
    const candidate = byId.get(modelId);
    if (!candidate) throw new Error(`Unknown candidate ${modelId}`);
    const perSeed = [];
    for (const seed of seeds) {
      const result = trajectory.collectInteractiveTrajectories(panel, {
        modelId,
        costModel: availability.availabilityCostModelFor(candidate),
        toleranceOverride: candidate.tolerance,
        runs: runsPerSeed,
        seed,
        timeBudgetMs: trajectoryBudgetMs,
      });
      if (result.status !== "completed") {
        return { status: result.status, reason: result.reason, perSeed: null };
      }
      const samples = result.samples.map((s) => metrics.maxSupplyDebtDays(s.consumption));
      const completed = result.samples.filter((s) => s.completed).length;
      perSeed.push({
        seed,
        completionRate: result.samples.length ? completed / result.samples.length : 0,
        samples,
      });
    }
    return { status: "completed", perSeed };
  }

  const panels = journeyPanelIds.map((id) => journey.journeyPanelById(id));

  // Baseline arrays per panel (collected once, reused for every contender).
  const baselineArrays = new Map();
  for (const panel of panels) baselineArrays.set(panel.id, collectPanelArray(BASELINE_ID, panel));

  const candidateResults = [];
  for (const modelId of contenders) {
    const perPanel = [];
    for (const panel of panels) {
      const baseArr = baselineArrays.get(panel.id);
      const candArr = collectPanelArray(modelId, panel);
      if (baseArr.status !== "completed" || candArr.status !== "completed") {
        perPanel.push({
          panel: panel.id,
          status: "judgement_incomplete",
          reason: baseArr.status !== "completed" ? `baseline:${baseArr.reason}` : candArr.reason,
        });
        continue;
      }
      // Match the deep journey gate: drop any seed under-completed by EITHER arm, from BOTH arms
      // (keeps per-index CRN pairing + equal lengths). `gated` also carries completion diagnostics.
      const gated = gate.gatePairedSeeds(baseArr.perSeed, candArr.perSeed, completionThreshold);
      if (gated.status !== "completed") {
        perPanel.push({
          panel: panel.id,
          status: "judgement_incomplete",
          reason: gated.reason,
          completionMin: gated.completionMin,
          seedsKept: gated.seedsKept,
          seedsTotal: gated.seedsTotal,
          seedsGated: gated.seedsGated,
        });
        continue;
      }
      // Display CI of the improvement, oriented so positive = candidate has LOWER supplyDebt tail.
      // (baseline=A, candidate=cand, lower-is-better => improvement = cvar90(A) - cvar90(cand))
      const display = stats.pairedBootstrapImprovement(gated.basePool, gated.candPool, {
        higherIsBetter: false,
        statistic: cvar90,
        resamples,
        confidence,
        seed: bootstrapSeed,
      });
      // Holm-compatible IMPROVEMENT p-value. The library's adversePValue is built to detect
      // WORSENING (low => confirmed worse). To confirm the candidate IMPROVES, we swap roles
      // (treat the candidate as the baseline): then a low adversePValue means "A is confirmed
      // worse than the candidate" = the candidate significantly improves supplyDebt.
      const improveTest = stats.pairedBootstrapImprovement(gated.candPool, gated.basePool, {
        higherIsBetter: false,
        statistic: cvar90,
        resamples,
        confidence,
        seed: bootstrapSeed,
      });
      perPanel.push({
        panel: panel.id,
        status: "completed",
        pointImprovement: display.pointImprovement,
        confidenceLower: display.confidenceLower,
        confidenceUpper: display.confidenceUpper,
        adversePValue: improveTest.adversePValue,
        completionMin: gated.completionMin, // diagnostic (#2): min completionRate over A+cand seeds
        seedsKept: gated.seedsKept,
        seedsTotal: gated.seedsTotal,
        seedsGated: gated.seedsGated,
      });
    }
    const completed = perPanel.filter((p) => p.status === "completed");
    const judgeable = completed.length === perPanel.length && perPanel.length > 0;
    const allPanelsCiPositive = judgeable && completed.every((p) => p.confidenceLower > 0);
    // conservative aggregate p-value across panels (worst panel)
    const adversePValue = judgeable ? Math.max(...completed.map((p) => p.adversePValue)) : 1;
    candidateResults.push({
      candidateId: modelId,
      perPanel,
      judgeable,
      allPanelsCiPositive,
      adversePValue,
    });
  }

  // Holm-Bonferroni across contenders (reinterpreted: low adverse p-value => confirmed improvement).
  const holm = stats.holmBonferroniWorseningDecisions(
    candidateResults.map((c) => ({ id: c.candidateId, adversePValue: c.adversePValue })),
    alpha,
  );
  const holmById = new Map(holm.map((d) => [d.id, d]));

  const candidates = candidateResults.map((c) => {
    const decision = holmById.get(c.candidateId);
    const holmConfirmedImprovement = Boolean(decision?.confirmedWorsening) && c.judgeable;
    return {
      ...c,
      holmThreshold: decision ? decision.threshold : null,
      holmConfirmedImprovement,
      // significant improvement = every panel's CI strictly above 0 AND Holm-confirmed.
      significantImprovement: c.allPanelsCiPositive && holmConfirmedImprovement,
    };
  });

  const out = {
    ...baseOutput,
    contenders,
    candidates,
    note: "significantImprovement = (all panels CI lower > 0) AND Holm-confirmed at alpha.",
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        kind: out.kind,
        contenders,
        significant: candidates.filter((c) => c.significantImprovement).map((c) => c.candidateId),
        output: OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
