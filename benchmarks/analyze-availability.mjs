// Read-only analysis of the availability calibration pipeline. Reads the deep-slice results plus
// (optionally) the significance and selection outputs and prints a consolidated, human-readable
// view: per-candidate exact P-loss, per-journey-panel supplyDebt CVaR90 (incl. the skewed
// demand300 panel), the worst-panel y-axis value vs A, contender status, significance verdicts,
// and the final stage selection. Pure Node (no solving / no vite) — safe to run anytime, including
// while the deep re-run is still in progress (degrades gracefully on partial data).
//
//   node benchmarks/analyze-availability.mjs
//   BASELINE=tau0.01-h0.5-p3 DELTA_P=0.005 node benchmarks/analyze-availability.mjs

import { readFile } from "node:fs/promises";

const R = new URL("./results/", import.meta.url);
const DEEP = new URL("availability-deep-slice.json", R);
const DEEP_SINGLE = new URL("availability-deep.json", R);
const SIG = new URL("availability-significance.json", R);
const SEL = new URL("availability-selection.json", R);

const BASELINE = process.env.BASELINE || "tau0.01-h0.5-p3";
const DELTA_P = Number(process.env.DELTA_P || 0.005);
const EPS = 1e-9;

async function readJsonOrNull(url) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function fmt(value, digits = 3) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "  —  "
    : value.toFixed(digits);
}

function max(values) {
  return values.length ? Math.max(...values) : null;
}
function min(values) {
  return values.length ? Math.min(...values) : null;
}

// Per-candidate worst exact P-loss vs A (max over completed gate scenarios).
function worstExactLoss(deep, modelId) {
  if (modelId === BASELINE) return 0;
  const losses = (deep.exactResults || [])
    .filter((e) => e.modelId === modelId && e.status === "completed")
    .map((e) => Number(e.exactLossVsA))
    .filter(Number.isFinite);
  return losses.length ? max(losses) : null;
}

// Per-candidate, per-panel supplyDebt, matching the deep runner's aggregateJourneyDemand: each
// (panel, seed) seed-job is gated INDIVIDUALLY (completionRate >= 0.995); the per-panel value is
// the max CVaR90 over the seeds that pass, and a panel counts if >= 1 seed passes. We also surface
// how many seeds passed (e.g. 3/4) so a marginally-completing panel stays visible.
function panelBreakdown(journeyEntry) {
  const bySeedPanel = new Map();
  for (const p of journeyEntry?.panels || []) {
    const e = bySeedPanel.get(p.scenario) || { passCvars: [], comps: [], passed: 0, total: 0 };
    e.total += 1;
    if (p.status === "completed" && p.summary) {
      e.comps.push(p.summary.completionRate);
      if (p.summary.completionRate >= 0.995) {
        e.passCvars.push(p.summary.maxSupplyDebtDaysCvar90);
        e.passed += 1;
      }
    }
    bySeedPanel.set(p.scenario, e);
  }
  const panels = new Map();
  for (const [panelId, e] of bySeedPanel) {
    panels.set(panelId, {
      cvar90: e.passCvars.length ? max(e.passCvars) : null, // max over PASSING seeds (matches deep)
      completionMin: e.comps.length ? min(e.comps) : null,
      passed: e.passed,
      total: e.total,
      judged: e.passCvars.length > 0,
    });
  }
  return panels;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

async function main() {
  const deep = (await readJsonOrNull(DEEP)) || (await readJsonOrNull(DEEP_SINGLE));
  if (!deep) {
    console.log("No deep results found yet (benchmarks/results/availability-deep-slice.json).");
    return;
  }
  const significance = await readJsonOrNull(SIG);
  const selection = await readJsonOrNull(SEL);

  // ---- deep progress -----------------------------------------------------------------------
  const panelIds = deep.config?.journeyPanelIds || [];
  const journeyEntries = new Map((deep.journeyDemand || []).map((j) => [j.candidateId, j]));
  const allPanelJobs = (deep.journeyDemand || []).flatMap((c) => c.panels);
  const journeyDone = allPanelJobs.filter((p) => p.status === "completed").length;
  console.log("=".repeat(96));
  console.log(
    `DEEP  phase=${deep.phase}  exact=${(deep.exactResults || []).length}` +
      `  finiteTail=${(deep.finiteStockTail || []).length}  journeyJobs=${journeyDone}`,
  );
  console.log(`      journeyPanels = [${panelIds.join(", ")}]`);
  console.log(`      generatedAt=${deep.generatedAt}`);
  if (deep.phase !== "completed") {
    console.log("      ⚠ deep is still in progress — figures below are partial.");
  }
  console.log("=".repeat(96));

  // ---- per-candidate coordinates -----------------------------------------------------------
  const candidateIds = Array.from(
    new Set([
      ...(deep.journeyDemand || []).map((j) => j.candidateId),
      ...(deep.exactResults || []).map((e) => e.modelId),
    ]),
  );
  const rows = candidateIds.map((id) => {
    const entry = journeyEntries.get(id);
    const panels = panelBreakdown(entry);
    // Authoritative y-axis = the deep's own stored aggregate (exactly what select consumes).
    const storedMax =
      entry && Number.isFinite(Number(entry.maxPanelSupplyDebtCvar90))
        ? Number(entry.maxPanelSupplyDebtCvar90)
        : null;
    // Which judged panel achieves that max (for the "binding" column).
    let maxPanelId = null;
    let bestV = -Infinity;
    for (const [pid, p] of panels)
      if (p.judged && p.cvar90 > bestV) {
        bestV = p.cvar90;
        maxPanelId = pid;
      }
    return {
      id,
      loss: worstExactLoss(deep, id),
      panels,
      maxPanel: storedMax,
      maxPanelId,
    };
  });
  const aRow = rows.find((r) => r.id === BASELINE);
  const aDebt = aRow?.maxPanel ?? null;

  // Table: id | loss | per-panel cvar90 | maxPanel | vsA | binding panel
  const header =
    pad("candidate", 17) +
    padL("P-loss", 8) +
    "  " +
    panelIds.map((p) => padL(p.replace("balanced", "bal").replace("demand", "dem"), 11)).join("") +
    "  " +
    padL("MAXpanel", 9) +
    padL("vsA", 9) +
    "  binding";
  console.log("\nPER-CANDIDATE  (supplyDebt CVaR90 per panel; — = not judged/sufficient)");
  console.log(header);
  console.log("-".repeat(header.length));
  rows.sort((a, b) => (a.maxPanel ?? Infinity) - (b.maxPanel ?? Infinity));
  for (const r of rows) {
    const cells = panelIds
      .map((pid) => padL(fmt(r.panels.get(pid)?.cvar90 ?? null, 1), 11))
      .join("");
    const vsA =
      r.maxPanel !== null && aDebt !== null
        ? r.id === BASELINE
          ? "  (A)"
          : (r.maxPanel < aDebt - EPS ? "▼" : "▲") + fmt(r.maxPanel - aDebt, 1)
        : "  —";
    const bindMark = r.maxPanelId
      ? r.maxPanelId.includes("demand")
        ? r.maxPanelId.replace("SR0-", "") + "★"
        : r.maxPanelId.replace("SR0-", "").replace("R0-", "")
      : "—";
    console.log(
      pad(r.id, 17) +
        padL(fmt(r.loss, 4), 8) +
        "  " +
        cells +
        "  " +
        padL(fmt(r.maxPanel, 1), 9) +
        padL(vsA, 9) +
        "  " +
        bindMark,
    );
  }

  // ---- marginal completion (panels where some but not all seeds clear 0.995) ----------------
  const marginal = [];
  for (const r of rows)
    for (const [pid, p] of r.panels)
      if (p.total > 0 && p.passed < p.total)
        marginal.push(
          `${pad(r.id, 17)} ${pad(pid, 16)} seeds ${p.passed}/${p.total} pass  minComp=${fmt(p.completionMin, 4)}`,
        );
  if (marginal.length) {
    console.log("\nMARGINAL COMPLETION  (panel kept via the seeds that pass per-seed 0.995 gate)");
    for (const line of marginal) console.log(`  ${line}`);
  }

  // ---- demand300 impact --------------------------------------------------------------------
  const demandPanel = panelIds.find((p) => p.includes("demand"));
  if (demandPanel) {
    console.log(
      `\nSKEWED PANEL IMPACT  (${demandPanel}; ★ = it is the candidate's worst/binding panel)`,
    );
    const boundByDemand = rows.filter((r) => r.maxPanelId === demandPanel);
    if (boundByDemand.length === 0) {
      console.log("  No candidate is bound by the skewed panel — it never raises the y-axis max.");
      console.log(
        "  (Expected if balanced demand is the harder supply test; skewed acts as a pass/confirm.)",
      );
    } else {
      for (const r of boundByDemand)
        console.log(`  ${pad(r.id, 17)} bound by ${demandPanel} (debt ${fmt(r.maxPanel, 1)})`);
    }
  } else {
    console.log(
      "\nSKEWED PANEL IMPACT  — no demand* panel present yet (deep re-run not finished).",
    );
  }

  // ---- contenders --------------------------------------------------------------------------
  if (aDebt !== null) {
    const contenders = rows.filter(
      (r) =>
        r.id !== BASELINE &&
        r.maxPanel !== null &&
        r.maxPanel < aDebt - EPS &&
        r.loss !== null &&
        r.loss <= DELTA_P + EPS,
    );
    console.log(
      `\n보존 CONTENDERS  (maxPanel supplyDebt < A=${fmt(aDebt, 1)} AND P-loss <= ΔP=${DELTA_P})`,
    );
    if (contenders.length === 0) console.log("  none");
    for (const r of contenders)
      console.log(
        `  ${pad(r.id, 17)} debt ${fmt(r.maxPanel, 1)} (${fmt(r.maxPanel - aDebt, 1)} vs A)  P-loss ${fmt(r.loss, 4)}`,
      );
  }

  // ---- significance ------------------------------------------------------------------------
  console.log("\nSIGNIFICANCE");
  if (!significance) {
    console.log("  not run yet (availability-significance.json absent).");
  } else if ((significance.candidates || []).length === 0) {
    console.log(`  ${significance.note || "no contenders tested."}`);
  } else {
    for (const c of significance.candidates) {
      const perPanel = (c.perPanel || [])
        .map(
          (p) =>
            `${p.panel.replace("SR0-", "").replace("R0-", "")}:${p.status === "completed" ? (p.confidenceLower > 0 ? "CI+" : "CI~") + fmt(p.confidenceLower, 1) : p.status}`,
        )
        .join(" ");
      console.log(
        `  ${pad(c.candidateId, 17)} significant=${c.significantImprovement ? "YES" : "no "}  Holm=${c.holmConfirmedImprovement}  [${perPanel}]`,
      );
    }
  }

  // ---- selection ---------------------------------------------------------------------------
  console.log("\nSELECTION");
  if (!selection) {
    console.log("  not run yet (availability-selection.json absent).");
  } else {
    console.log(
      `  outcome: ${selection.outcome}` +
        (selection.monotone !== undefined ? `  (monotone=${selection.monotone})` : ""),
    );
    if (selection.preservationProvisional)
      console.log("  ⚠ preservation provisional (no significance evidence)");
    if (selection.preservationEscalationSuggested)
      console.log("  → preservation escalation (p∈{4,∞}) suggested");
    for (const s of selection.stages || [])
      console.log(
        `    ${pad(s.stage, 8)} ${pad(s.modelId, 17)} loss=${fmt(s.worstExactLoss, 4)} debt=${fmt(s.supplyDebtCvar90, 1)} sigTail=${s.tailSignificantImprovement}`,
      );
    if (selection.paretoFrontier) console.log(`  Pareto: ${selection.paretoFrontier.join(", ")}`);
  }
  console.log("");
}

await main();
