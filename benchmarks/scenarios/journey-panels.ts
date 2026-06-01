import type { CollectionState, Stock } from "../../src/types";
import type { SolverScenario } from "./fixed-grid";

// ---------------------------------------------------------------------------
// Journey-demand panels (Pareto y-axis source) — SEPARATE from FIXED_SAFETY_GRID.
//
// FIXED_SAFETY_GRID is a frozen 96-cell safety contract (asserted at length 96 with five
// required sentinels). Journey panels are a *different* concept and therefore live in their
// own module so we never have to mutate that contract.
//
// A journey panel must satisfy two opposing requirements:
//   1. completion-sufficient — baseline A reaches SR15 with near-certainty
//      (completionRate >= JOURNEY_COMPLETION_THRESHOLD), so the measured total consumption is
//      the TRUE end-to-end journey demand and is NOT truncated by stock depletion.
//   2. shaping-preserving — finite enough that availability = stock + H*G stays the same order
//      as consumption. A "virtual large stock" degenerates (availability -> inf => cost -> 0 =>
//      the (H, p) shaping vanishes and we would be measuring a probability-first policy, not the
//      recommended one). This is why we never use an arbitrarily large stock.
//
// The journey-demand supplyDebt is therefore measured ONLY on these panels, never on the
// finite-stock scarcity scenarios (whose truncated consumption inverts the metric: an
// aggressive policy depletes a scarce kit faster, truncates earlier, and so reports LESS
// consumption and a falsely LOWER debt).
// ---------------------------------------------------------------------------

export const JOURNEY_COMPLETION_THRESHOLD = 0.995;

const JOURNEY_START_STATES = [
  { id: "R0", start: { grade: "R", level: 0, exp: 0 } },
  { id: "SR0", start: { grade: "SR", level: 0, exp: 0 } },
] as const satisfies ReadonlyArray<{ id: string; start: CollectionState }>;

// Candidate panel stocks, ordered smallest -> largest. The journey calibration step
// (run-availability-journey-calibrate.mjs) selects, per start state, the MINIMUM stock whose
// baseline completionRate >= threshold. Using the minimum (rather than the largest) keeps
// availability tightest and the (H, p) shaping best preserved, and it is the cheapest panel to
// evaluate.
const JOURNEY_BALANCED_STOCKS = [
  { id: "balanced150", stock: { blue: 150, purple: 150, yellow: 150 } },
  { id: "balanced200", stock: { blue: 200, purple: 200, yellow: 200 } },
  { id: "balanced250", stock: { blue: 250, purple: 250, yellow: 250 } },
  { id: "balanced300", stock: { blue: 300, purple: 300, yellow: 300 } },
] as const satisfies ReadonlyArray<{ id: string; stock: Stock }>;

// `demand###` is a deliberately skewed-but-completion-sufficient stock (blue-heavy, matching the
// observed ~237:61:56 SR0 journey demand) so the y-axis is not over-fit to a single
// perfectly-balanced stock shape.
//
// SKEWED PANELS ARE SR0-ONLY (by deliberate design, not oversight). A skewed panel needs a large
// blue stock to stay completion-sufficient (SR0-demand300 already runs blue=300 at only ~0.9952
// completion because the skewed availability pushes mean blue consumption up to ~237). At the R0
// start the full R0->R15->SR0->SR15 horizon makes each solve far more expensive AND that cost
// scales steeply with stock size (measured ~6x per +30 blue at R0), so an R0 skewed panel cannot
// finish inside the deep journey-tail budget. SR0 (shorter horizon) stays tractable: SR0-demand300
// saturates ~5200 policy keys at ~51 ms/solve (~270 s per 12k-run job, well under the budget).
// Balanced panels remain available at both start states because their smaller completion-sufficient
// stock (R0 needs only blue=150) keeps R0 solves cheap.
const JOURNEY_SKEWED_STOCKS = [
  { id: "demand300", stock: { blue: 300, purple: 150, yellow: 120 } },
] as const satisfies ReadonlyArray<{ id: string; stock: Stock }>;

const SKEWED_PANEL_START_IDS = new Set<string>(["SR0"]);

function makePanel(
  stateId: string,
  start: CollectionState,
  stockId: string,
  stock: Stock,
): SolverScenario {
  return {
    id: `${stateId}-${stockId}`,
    group: "balanced" as const,
    start: { ...start },
    stock: { ...stock },
  };
}

export const JOURNEY_PANEL_CANDIDATES: SolverScenario[] = JOURNEY_START_STATES.flatMap(
  ({ id: stateId, start }) => [
    ...JOURNEY_BALANCED_STOCKS.map(({ id: stockId, stock }) =>
      makePanel(stateId, start, stockId, stock),
    ),
    ...(SKEWED_PANEL_START_IDS.has(stateId)
      ? JOURNEY_SKEWED_STOCKS.map(({ id: stockId, stock }) =>
          makePanel(stateId, start, stockId, stock),
        )
      : []),
  ],
);

// Conservative default panels used when no calibration output is supplied: the largest/safest
// completion-sufficient balanced stock at both representative start states. Calibration is
// expected to replace these with the cheaper minimum-completion-sufficient stocks.
export const DEFAULT_JOURNEY_PANEL_IDS = ["R0-balanced300", "SR0-balanced300"];

export function journeyPanelById(id: string): SolverScenario {
  const panel = JOURNEY_PANEL_CANDIDATES.find((candidate) => candidate.id === id);
  if (!panel) {
    throw new Error(
      `Missing journey panel: ${id}. Known panels: ${JOURNEY_PANEL_CANDIDATES.map((p) => p.id).join(", ")}`,
    );
  }
  return panel;
}
