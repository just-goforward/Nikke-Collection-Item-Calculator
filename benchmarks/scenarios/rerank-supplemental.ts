import type { CollectionState, Stock } from "../../src/types";
import type { SolverScenario } from "./fixed-grid";

const RERANK_SUPPLEMENTAL_STATES = [
  { id: "R0", start: { grade: "R", level: 0, exp: 0 } },
  { id: "SR0", start: { grade: "SR", level: 0, exp: 0 } },
  { id: "SR10", start: { grade: "SR", level: 10, exp: 0 } },
  { id: "SR14e2900", start: { grade: "SR", level: 14, exp: 2900 } },
] as const satisfies ReadonlyArray<{ id: string; start: CollectionState }>;

// 28-day expected gain, rounded to 10-piece usable stock units.
// Source values are approximately blue=473.912, purple=55.808, yellow=24.736 pieces / 28 days.
const GAIN28_STOCKS = [
  { id: "gain28Third", stock: { blue: 160, purple: 20, yellow: 10 } },
  { id: "gain28Half", stock: { blue: 240, purple: 30, yellow: 10 } },
  { id: "gain28One", stock: { blue: 470, purple: 60, yellow: 20 } },
] as const satisfies ReadonlyArray<{ id: string; stock: Stock }>;

const STATE_IDS_BY_STOCK = {
  gain28Third: new Set(["R0", "SR0"]),
  gain28Half: new Set(["R0", "SR0"]),
  gain28One: new Set(["R0", "SR0", "SR10", "SR14e2900"]),
} as const;

function makeScenario(
  stateId: string,
  start: CollectionState,
  stockId: string,
  stock: Stock,
): SolverScenario {
  return {
    id: `${stateId}-${stockId}`,
    group: "balanced",
    start: { ...start },
    stock: { ...stock },
  };
}

export const RERANK_SUPPLEMENTAL_SCENARIOS: SolverScenario[] = GAIN28_STOCKS.flatMap(
  ({ id: stockId, stock }) =>
    RERANK_SUPPLEMENTAL_STATES.filter(({ id: stateId }) =>
      STATE_IDS_BY_STOCK[stockId].has(stateId),
    ).map(({ id: stateId, start }) => makeScenario(stateId, start, stockId, stock)),
);

export function rerankSupplementalScenarioById(id: string): SolverScenario {
  const scenario = RERANK_SUPPLEMENTAL_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(
      `Missing rerank supplemental scenario: ${id}. Known scenarios: ${RERANK_SUPPLEMENTAL_SCENARIOS.map((scenario) => scenario.id).join(", ")}`,
    );
  }
  return scenario;
}
