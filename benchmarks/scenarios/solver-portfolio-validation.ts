import type { CollectionState, Stock } from "../../src/types";
import type { SolverScenario } from "./fixed-grid";

const STATES = [
  { id: "R2e300", start: { grade: "R", level: 2, exp: 300 } },
  { id: "R6e1000", start: { grade: "R", level: 6, exp: 1000 } },
  { id: "R8e1400", start: { grade: "R", level: 8, exp: 1400 } },
] as const satisfies ReadonlyArray<{ id: string; start: CollectionState }>;

const STOCKS = [
  { id: "balanced205", group: "balanced", stock: { blue: 205, purple: 205, yellow: 205 } },
  { id: "balanced225", group: "balanced", stock: { blue: 225, purple: 225, yellow: 225 } },
  { id: "half300-150-150", group: "scarcity", stock: { blue: 300, purple: 150, yellow: 150 } },
  { id: "nearHalf300-151-151", group: "scarcity", stock: { blue: 300, purple: 151, yellow: 151 } },
  { id: "half360-300-180", group: "scarcity", stock: { blue: 360, purple: 300, yellow: 180 } },
  { id: "nearHalf360-300-181", group: "scarcity", stock: { blue: 360, purple: 300, yellow: 181 } },
  {
    id: "belowTotal299-150-150",
    group: "scarcity",
    stock: { blue: 299, purple: 150, yellow: 150 },
  },
  {
    id: "aboveTotal301-150-150",
    group: "scarcity",
    stock: { blue: 301, purple: 150, yellow: 150 },
  },
] as const satisfies ReadonlyArray<{
  id: string;
  group: SolverScenario["group"];
  stock: Stock;
}>;

export const SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS: SolverScenario[] = STATES.flatMap(
  ({ id: stateId, start }) =>
    STOCKS.map(({ id: stockId, group, stock }) => ({
      id: `validate-${stateId}-${stockId}`,
      group,
      start: { ...start },
      stock: { ...stock },
    })),
);
