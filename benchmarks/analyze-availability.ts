// Read-only analysis of the availability calibration pipeline.
//
// Reads deep results plus optional significance/selection outputs and prints a consolidated view:
// per-candidate exact P-loss, per-journey-panel supplyDebt CVaR90, significance verdicts, and the
// final stage selection. This script does not solve anything and can be run while deep evaluation
// is still in progress; partial data is reported as partial.

import { readFile } from "node:fs/promises";
import { isErrorWithCode } from "./runner-utils";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const DEEP_SLICE_FILE = new URL("availability-deep-slice.json", RESULTS_DIRECTORY);
const DEEP_SINGLE_FILE = new URL("availability-deep.json", RESULTS_DIRECTORY);
const SIGNIFICANCE_FILE = new URL("availability-significance.json", RESULTS_DIRECTORY);
const SELECTION_FILE = new URL("availability-selection.json", RESULTS_DIRECTORY);

const BASELINE = process.env.BASELINE || "tau0.01-h0.5-p3";
const DELTA_P = Number(process.env.DELTA_P || 0.005);
const EPS = 1e-9;

type DeepExactEntry = {
  modelId: string;
  status: string;
  exactLossVsA?: number | null;
};

type DeepPanelSummary = {
  completionRate?: number;
  maxSupplyDebtDaysCvar90?: number;
};

type DeepJourneyPanel = {
  scenario: string;
  status: string;
  summary?: DeepPanelSummary;
};

type DeepJourneyDemandEntry = {
  candidateId: string;
  maxPanelSupplyDebtCvar90?: number | null;
  panels?: DeepJourneyPanel[];
};

type DeepReport = {
  phase?: string;
  generatedAt?: string;
  config?: { journeyPanelIds?: string[] };
  options?: { journeyPanelIds?: string[] };
  exactResults?: DeepExactEntry[];
  finiteStockTail?: unknown[];
  journeyDemand?: DeepJourneyDemandEntry[];
};

type SignificancePanel = {
  panel: string;
  status: string;
  confidenceLower?: number;
};

type SignificanceCandidate = {
  candidateId: string;
  significantImprovement?: boolean;
  holmConfirmedImprovement?: boolean;
  perPanel?: SignificancePanel[];
};

type SignificanceReport = {
  note?: string;
  candidates?: SignificanceCandidate[];
};

type SelectionStage = {
  stage: string;
  modelId: string;
  worstExactLoss?: number | null;
  supplyDebtCvar90?: number | null;
  tailSignificantImprovement?: boolean | null;
};

type SelectionReport = {
  outcome?: string;
  monotone?: boolean;
  preservationProvisional?: boolean;
  preservationEscalationSuggested?: boolean;
  stages?: SelectionStage[];
  paretoFrontier?: string[];
};

type PanelBreakdown = {
  cvar90: number | null;
  completionMin: number | null;
  passed: number;
  total: number;
  judged: boolean;
};

async function readJsonOrNull<T>(url: URL, reader: (value: unknown) => T): Promise<T | null> {
  try {
    return reader(JSON.parse(await readFile(url, "utf8")));
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readDeepReport(value: unknown): DeepReport {
  const object = asObject(value);
  if (!object) return {};
  return {
    phase: typeof object.phase === "string" ? object.phase : undefined,
    generatedAt: typeof object.generatedAt === "string" ? object.generatedAt : undefined,
    config: asObject(object.config) as DeepReport["config"],
    options: asObject(object.options) as DeepReport["options"],
    exactResults: Array.isArray(object.exactResults)
      ? (object.exactResults as DeepExactEntry[])
      : [],
    finiteStockTail: Array.isArray(object.finiteStockTail) ? object.finiteStockTail : [],
    journeyDemand: Array.isArray(object.journeyDemand)
      ? (object.journeyDemand as DeepJourneyDemandEntry[])
      : [],
  };
}

function readSignificanceReport(value: unknown): SignificanceReport {
  const object = asObject(value);
  if (!object) return {};
  return {
    note: typeof object.note === "string" ? object.note : undefined,
    candidates: Array.isArray(object.candidates)
      ? (object.candidates as SignificanceCandidate[])
      : [],
  };
}

function readSelectionReport(value: unknown): SelectionReport {
  const object = asObject(value);
  if (!object) return {};
  return {
    outcome: typeof object.outcome === "string" ? object.outcome : undefined,
    monotone: typeof object.monotone === "boolean" ? object.monotone : undefined,
    preservationProvisional: Boolean(object.preservationProvisional),
    preservationEscalationSuggested: Boolean(object.preservationEscalationSuggested),
    stages: Array.isArray(object.stages) ? (object.stages as SelectionStage[]) : [],
    paretoFrontier: Array.isArray(object.paretoFrontier)
      ? object.paretoFrontier.filter((id): id is string => typeof id === "string")
      : undefined,
  };
}

function fmt(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "  -- "
    : value.toFixed(digits);
}

function max(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function min(values: number[]): number | null {
  return values.length ? Math.min(...values) : null;
}

function pad(value: unknown, width: number): string {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(value: unknown, width: number): string {
  const text = String(value);
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function worstExactLoss(deep: DeepReport, modelId: string): number | null {
  if (modelId === BASELINE) return 0;
  const losses = (deep.exactResults ?? [])
    .filter((entry) => entry.modelId === modelId && entry.status === "completed")
    .map((entry) => Number(entry.exactLossVsA))
    .filter((value) => Number.isFinite(value));
  return losses.length ? max(losses) : null;
}

function panelBreakdown(
  journeyEntry: DeepJourneyDemandEntry | undefined,
): Map<string, PanelBreakdown> {
  const byPanel = new Map<
    string,
    { passCvars: number[]; completions: number[]; passed: number; total: number }
  >();

  for (const panel of journeyEntry?.panels ?? []) {
    const entry = byPanel.get(panel.scenario) ?? {
      passCvars: [],
      completions: [],
      passed: 0,
      total: 0,
    };
    entry.total += 1;
    if (panel.status === "completed" && panel.summary) {
      const completionRate = Number(panel.summary.completionRate);
      entry.completions.push(completionRate);
      if (completionRate >= 0.995) {
        entry.passCvars.push(Number(panel.summary.maxSupplyDebtDaysCvar90));
        entry.passed += 1;
      }
    }
    byPanel.set(panel.scenario, entry);
  }

  const panels = new Map<string, PanelBreakdown>();
  for (const [panelId, entry] of byPanel) {
    panels.set(panelId, {
      cvar90: entry.passCvars.length ? max(entry.passCvars) : null,
      completionMin: entry.completions.length ? min(entry.completions) : null,
      passed: entry.passed,
      total: entry.total,
      judged: entry.passCvars.length > 0,
    });
  }
  return panels;
}

async function main(): Promise<void> {
  const deep =
    (await readJsonOrNull(DEEP_SLICE_FILE, readDeepReport)) ||
    (await readJsonOrNull(DEEP_SINGLE_FILE, readDeepReport));
  if (!deep) {
    console.log("No deep results found yet (benchmarks/results/availability-deep-slice.json).");
    return;
  }

  const significance = await readJsonOrNull(SIGNIFICANCE_FILE, readSignificanceReport);
  const selection = await readJsonOrNull(SELECTION_FILE, readSelectionReport);
  const panelIds = deep.config?.journeyPanelIds || deep.options?.journeyPanelIds || [];
  const journeyEntries = new Map(
    (deep.journeyDemand ?? []).map((entry) => [entry.candidateId, entry]),
  );
  const allPanelJobs = (deep.journeyDemand ?? []).flatMap((candidate) => candidate.panels ?? []);
  const journeyDone = allPanelJobs.filter((panel) => panel.status === "completed").length;

  console.log("=".repeat(96));
  console.log(
    `DEEP  phase=${deep.phase ?? "unknown"}  exact=${deep.exactResults?.length ?? 0}` +
      `  finiteTail=${deep.finiteStockTail?.length ?? 0}  journeyJobs=${journeyDone}`,
  );
  console.log(`      journeyPanels = [${panelIds.join(", ")}]`);
  console.log(`      generatedAt=${deep.generatedAt ?? "unknown"}`);
  if (deep.phase !== "completed") {
    console.log("      NOTE: deep is still in progress; figures below are partial.");
  }
  console.log("=".repeat(96));

  const candidateIds = Array.from(
    new Set([
      ...(deep.journeyDemand ?? []).map((entry) => entry.candidateId),
      ...(deep.exactResults ?? []).map((entry) => entry.modelId),
    ]),
  );
  const rows = candidateIds.map((id) => {
    const entry = journeyEntries.get(id);
    const panels = panelBreakdown(entry);
    const storedMax =
      entry && Number.isFinite(Number(entry.maxPanelSupplyDebtCvar90))
        ? Number(entry.maxPanelSupplyDebtCvar90)
        : null;
    let maxPanelId: string | null = null;
    let maxValue = -Infinity;
    for (const [panelId, panel] of panels) {
      if (panel.judged && panel.cvar90 !== null && panel.cvar90 > maxValue) {
        maxValue = panel.cvar90;
        maxPanelId = panelId;
      }
    }
    return {
      id,
      loss: worstExactLoss(deep, id),
      panels,
      maxPanel: storedMax,
      maxPanelId,
    };
  });

  const baselineRow = rows.find((row) => row.id === BASELINE);
  const baselineDebt = baselineRow?.maxPanel ?? null;
  const header =
    pad("candidate", 17) +
    padLeft("P-loss", 8) +
    "  " +
    panelIds
      .map((panelId) => padLeft(panelId.replace("balanced", "bal").replace("demand", "dem"), 11))
      .join("") +
    "  " +
    padLeft("MAXpanel", 9) +
    padLeft("vsA", 9) +
    "  binding";

  console.log("\nPER-CANDIDATE  (supplyDebt CVaR90 per panel; -- = not judged/sufficient)");
  console.log(header);
  console.log("-".repeat(header.length));
  rows.sort((left, right) => (left.maxPanel ?? Infinity) - (right.maxPanel ?? Infinity));
  for (const row of rows) {
    const cells = panelIds
      .map((panelId) => padLeft(fmt(row.panels.get(panelId)?.cvar90 ?? null, 1), 11))
      .join("");
    const vsBaseline =
      row.maxPanel !== null && baselineDebt !== null
        ? row.id === BASELINE
          ? "  (A)"
          : `${row.maxPanel < baselineDebt - EPS ? "DOWN" : "UP"}${fmt(row.maxPanel - baselineDebt, 1)}`
        : "  --";
    const binding = row.maxPanelId
      ? row.maxPanelId.includes("demand")
        ? `${row.maxPanelId.replace("SR0-", "")}*`
        : row.maxPanelId.replace("SR0-", "").replace("R0-", "")
      : "--";
    console.log(
      pad(row.id, 17) +
        padLeft(fmt(row.loss, 4), 8) +
        "  " +
        cells +
        "  " +
        padLeft(fmt(row.maxPanel, 1), 9) +
        padLeft(vsBaseline, 9) +
        "  " +
        binding,
    );
  }

  const marginal: string[] = [];
  for (const row of rows) {
    for (const [panelId, panel] of row.panels) {
      if (panel.total > 0 && panel.passed < panel.total) {
        marginal.push(
          `${pad(row.id, 17)} ${pad(panelId, 16)} seeds ${panel.passed}/${panel.total} pass  minComp=${fmt(panel.completionMin, 4)}`,
        );
      }
    }
  }
  if (marginal.length) {
    console.log("\nMARGINAL COMPLETION  (panel kept via seeds that pass per-seed 0.995 gate)");
    for (const line of marginal) console.log(`  ${line}`);
  }

  const demandPanel = panelIds.find((panelId) => panelId.includes("demand"));
  if (demandPanel) {
    console.log(`\nSKEWED PANEL IMPACT  (${demandPanel}; * = worst/binding panel)`);
    const boundByDemand = rows.filter((row) => row.maxPanelId === demandPanel);
    if (boundByDemand.length === 0) {
      console.log("  No candidate is bound by the skewed panel.");
    } else {
      for (const row of boundByDemand) {
        console.log(`  ${pad(row.id, 17)} bound by ${demandPanel} (debt ${fmt(row.maxPanel, 1)})`);
      }
    }
  } else {
    console.log("\nSKEWED PANEL IMPACT  -- no demand* panel present yet.");
  }

  if (baselineDebt !== null) {
    const contenders = rows.filter(
      (row) =>
        row.id !== BASELINE &&
        row.maxPanel !== null &&
        row.maxPanel < baselineDebt - EPS &&
        row.loss !== null &&
        row.loss <= DELTA_P + EPS,
    );
    console.log(
      `\nPRESERVATION CONTENDERS  (maxPanel supplyDebt < A=${fmt(baselineDebt, 1)} AND P-loss <= deltaP=${DELTA_P})`,
    );
    if (contenders.length === 0) console.log("  none");
    for (const row of contenders) {
      console.log(
        `  ${pad(row.id, 17)} debt ${fmt(row.maxPanel, 1)} (${fmt((row.maxPanel ?? 0) - baselineDebt, 1)} vs A)  P-loss ${fmt(row.loss, 4)}`,
      );
    }
  }

  console.log("\nSIGNIFICANCE");
  if (!significance) {
    console.log("  not run yet (availability-significance.json absent).");
  } else if ((significance.candidates ?? []).length === 0) {
    console.log(`  ${significance.note || "no contenders tested."}`);
  } else {
    for (const candidate of significance.candidates ?? []) {
      const perPanel = (candidate.perPanel ?? [])
        .map((panel) => {
          const label = panel.panel.replace("SR0-", "").replace("R0-", "");
          const status =
            panel.status === "completed"
              ? `${(panel.confidenceLower ?? 0) > 0 ? "CI+" : "CI~"}${fmt(panel.confidenceLower, 1)}`
              : panel.status;
          return `${label}:${status}`;
        })
        .join(" ");
      console.log(
        `  ${pad(candidate.candidateId, 17)} significant=${candidate.significantImprovement ? "YES" : "no "}  Holm=${candidate.holmConfirmedImprovement}  [${perPanel}]`,
      );
    }
  }

  console.log("\nSELECTION");
  if (!selection) {
    console.log("  not run yet (availability-selection.json absent).");
  } else {
    console.log(
      `  outcome: ${selection.outcome ?? "unknown"}` +
        (selection.monotone !== undefined ? `  (monotone=${selection.monotone})` : ""),
    );
    if (selection.preservationProvisional) {
      console.log("  NOTE: preservation provisional (no significance evidence)");
    }
    if (selection.preservationEscalationSuggested) {
      console.log("  NOTE: preservation escalation (p in {4, Infinity}) suggested");
    }
    for (const stage of selection.stages ?? []) {
      console.log(
        `    ${pad(stage.stage, 8)} ${pad(stage.modelId, 17)} loss=${fmt(stage.worstExactLoss, 4)} debt=${fmt(stage.supplyDebtCvar90, 1)} sigTail=${stage.tailSignificantImprovement}`,
      );
    }
    if (selection.paretoFrontier) {
      console.log(`  Pareto: ${selection.paretoFrontier.join(", ")}`);
    }
  }
  console.log("");
}

await main();
