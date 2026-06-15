// Journey-panel calibration.
//
// Finds, for baseline A, the minimum completion-sufficient balanced stock per start state
// (the cheapest panel whose completionRate >= JOURNEY_COMPLETION_THRESHOLD) plus any
// completion-sufficient skewed demand-shaped panel. Using the minimum keeps availability tight so
// the (H, p) shaping is preserved, and is cheaper than always using balanced300.
//
// Output: benchmarks/results/availability-journey-calibration.json with
// `recommendedJourneyPanelIds`, which can be passed to the deep runner via
// AVAILABILITY_DEEP_JOURNEY_PANELS.

import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import type { Stock } from "../src/types";
import type { TrajectoryTailSummary } from "./metrics";
import { envValue, parsePositiveInteger } from "./runner-utils";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/availability-journey-calibration.json", import.meta.url);

const runs = parsePositiveInteger(envValue("AVAILABILITY_JOURNEY_RUNS"), 4000);
const seed = parsePositiveInteger(envValue("AVAILABILITY_JOURNEY_SEED"), 20260505);
// Skewed SR0 panels are legitimately expensive, so give each panel a generous default budget.
// Early termination below means only a handful of panels normally run.
const budgetMs = parsePositiveInteger(envValue("AVAILABILITY_JOURNEY_BUDGET_MS"), 300_000);

type JourneyCalibrationEvaluation =
  | {
      panel: string;
      status: "skipped";
      reason: "minimum_sufficient_balanced_already_found";
    }
  | {
      panel: string;
      status: "verification_incomplete";
      reason: "time_budget_exceeded";
      runsCompleted: number;
      elapsedMs: number;
    }
  | {
      panel: string;
      status: "completed";
      stock: Stock;
      shape: "balanced" | "skewed";
      completionRate: number;
      completionSufficient: boolean;
      maxSupplyDebtDaysCvar90: number;
      meanConsumption: TrajectoryTailSummary["meanConsumption"];
      elapsedMs: number;
    };

function startStateOf(panelId: string): string {
  return panelId.split("-")[0] ?? panelId;
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
  const journey = (await server.ssrLoadModule(
    "/benchmarks/scenarios/journey-panels.ts",
  )) as typeof import("./scenarios/journey-panels");
  const availability = (await server.ssrLoadModule(
    "/benchmarks/models/availability-grid.ts",
  )) as typeof import("./models/availability-grid");
  const trajectory = (await server.ssrLoadModule(
    "/benchmarks/evaluator/trajectory.ts",
  )) as typeof import("./evaluator/trajectory");
  const metrics = (await server.ssrLoadModule(
    "/benchmarks/metrics.ts",
  )) as typeof import("./metrics");

  const baseline = availability.BASELINE_AVAILABILITY_CANDIDATE;
  const threshold = journey.JOURNEY_COMPLETION_THRESHOLD;
  const panels = journey.JOURNEY_PANEL_CANDIDATES;

  // Panels are declared smallest -> largest within each start state, so the first
  // completion-sufficient balanced panel encountered per start state is the minimum.
  const evaluations: JourneyCalibrationEvaluation[] = [];
  const minimumSufficientBalancedFound = new Set<string>();
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

  const recommended: string[] = [];
  const byStart = new Map<
    string,
    Extract<JourneyCalibrationEvaluation, { status: "completed" }>[]
  >();
  for (const evaluation of evaluations) {
    if (evaluation.status !== "completed") continue;
    const start = startStateOf(evaluation.panel);
    const existing = byStart.get(start) ?? [];
    existing.push(evaluation);
    byStart.set(start, existing);
  }

  for (const evaluationsForStart of byStart.values()) {
    const minimumBalanced = evaluationsForStart.find(
      (evaluation) => evaluation.shape === "balanced" && evaluation.completionSufficient,
    );
    if (minimumBalanced) recommended.push(minimumBalanced.panel);

    const skewed = evaluationsForStart.find(
      (evaluation) => evaluation.shape === "skewed" && evaluation.completionSufficient,
    );
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
        evaluations: evaluations.map((evaluation) => ({
          panel: evaluation.panel,
          completionRate: evaluation.status === "completed" ? evaluation.completionRate : null,
          sufficient: evaluation.status === "completed" ? evaluation.completionSufficient : false,
          status: evaluation.status,
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
