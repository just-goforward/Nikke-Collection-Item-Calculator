// Journey-panel calibration (correction #4 / round-14 보강 2·3).
//
// Finds, for baseline A, the MINIMUM completion-sufficient balanced stock per start state
// (the cheapest panel whose completionRate >= JOURNEY_COMPLETION_THRESHOLD) plus any
// completion-sufficient skewed (demand-shaped) panel. Using the minimum keeps availability
// tight so the (H, p) shaping is preserved, and is far cheaper than balanced300.
//
// Output: benchmarks/results/availability-journey-calibration.json with `recommendedJourneyPanelIds`,
// which can be passed to the deep runner via AVAILABILITY_DEEP_JOURNEY_PANELS.

import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/availability-journey-calibration.json", import.meta.url);

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

const runs = parsePositiveInteger(process.env.AVAILABILITY_JOURNEY_RUNS, 4000);
const seed = parsePositiveInteger(process.env.AVAILABILITY_JOURNEY_SEED, 20260505);
// Skewed SR0 panels are legitimately expensive (~270 s per 8k-run job in isolation), so give each
// panel a generous default budget. Early-termination (below) means only a handful of panels
// actually run, so total wall time stays modest.
const budgetMs = parsePositiveInteger(process.env.AVAILABILITY_JOURNEY_BUDGET_MS, 300_000);

function startStateOf(panelId) {
  return panelId.split("-")[0];
}

await mkdir(RESULTS_DIRECTORY, { recursive: true });

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

  const baseline = availability.BASELINE_AVAILABILITY_CANDIDATE;
  const threshold = journey.JOURNEY_COMPLETION_THRESHOLD;
  const panels = journey.JOURNEY_PANEL_CANDIDATES;

  // Panels are declared smallest -> largest within each start state, so the first
  // completion-sufficient balanced panel encountered per start state is the minimum.
  //
  // Early-termination: once the minimum completion-sufficient BALANCED stock is found for a start
  // state, skip the remaining (larger) balanced stocks for that start state. Those larger panels
  // are never recommended (the minimum already wins) and are the most expensive to evaluate — at
  // the R0 start they time out entirely and their accumulated memory then starves the later
  // (tractable) SR0 skewed panel. Skewed panels are always evaluated.
  const evaluations = [];
  const minimumSufficientBalancedFound = new Set();
  for (const panel of panels) {
    const start = startStateOf(panel.id);
    const isSkewed = panel.id.includes("demand");
    if (!isSkewed && minimumSufficientBalancedFound.has(start)) {
      evaluations.push({
        panel: panel.id,
        status: "skipped",
        reason: "minimum_sufficient_balanced_already_found",
      });
      continue;
    }
    const result = trajectory.collectInteractiveTrajectories(panel, {
      modelId: baseline.id,
      costModel: availability.availabilityCostModelFor(baseline),
      toleranceOverride: baseline.tolerance,
      runs,
      seed,
      timeBudgetMs: budgetMs,
    });
    if (result.status !== "completed") {
      evaluations.push({
        panel: panel.id,
        status: result.status,
        reason: result.reason,
        runsCompleted: result.runsCompleted,
        elapsedMs: result.elapsedMs,
      });
      continue;
    }
    const summary = metrics.summarizeTrajectories(result.samples);
    const completionSufficient = summary.completionRate >= threshold;
    evaluations.push({
      panel: panel.id,
      status: "completed",
      stock: panel.stock,
      shape: isSkewed ? "skewed" : "balanced",
      completionRate: summary.completionRate,
      completionSufficient,
      maxSupplyDebtDaysCvar90: summary.maxSupplyDebtDaysCvar90,
      meanConsumption: summary.meanConsumption,
      elapsedMs: result.elapsedMs,
    });
    if (!isSkewed && completionSufficient) minimumSufficientBalancedFound.add(start);
  }

  const recommended = [];
  const byStart = new Map();
  for (const ev of evaluations) {
    if (ev.status !== "completed") continue;
    const start = startStateOf(ev.panel);
    if (!byStart.has(start)) byStart.set(start, []);
    byStart.get(start).push(ev);
  }
  for (const [, evs] of byStart) {
    const minimumBalanced = evs.find((ev) => ev.shape === "balanced" && ev.completionSufficient);
    if (minimumBalanced) recommended.push(minimumBalanced.panel);
    const skewed = evs.find((ev) => ev.shape === "skewed" && ev.completionSufficient);
    if (skewed) recommended.push(skewed.panel);
  }

  const report = {
    kind: "availability-journey-calibration",
    version: 1,
    generatedAt: new Date().toISOString(),
    completionThreshold: threshold,
    runs,
    seed,
    budgetMs,
    evaluations,
    recommendedJourneyPanelIds: recommended,
    conservativeDefaultIds: journey.DEFAULT_JOURNEY_PANEL_IDS,
    note:
      recommended.length > 0
        ? "Pass recommendedJourneyPanelIds to the deep runner via AVAILABILITY_DEEP_JOURNEY_PANELS."
        : "No completion-sufficient panel found within the configured runs/budget; fall back to conservativeDefaultIds (balanced300).",
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        completionThreshold: threshold,
        recommendedJourneyPanelIds: recommended,
        evaluations: evaluations.map((ev) => ({
          panel: ev.panel,
          completionRate: ev.completionRate ?? null,
          sufficient: ev.completionSufficient ?? false,
          status: ev.status,
        })),
        output: OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
