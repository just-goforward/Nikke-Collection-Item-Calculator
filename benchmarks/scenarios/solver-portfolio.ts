import type { CollectionState, Stock } from "../../src/types";
import { FIXED_SAFETY_GRID, type SolverScenario } from "./fixed-grid.ts";
import { PRODUCT_RERANK_SCENARIOS } from "./rerank-product.ts";
import { RERANK_SUPPLEMENTAL_SCENARIOS } from "./rerank-supplemental.ts";

export type SolverPortfolioScenario = SolverScenario & {
  cohort: "confirmation" | "discovery";
};

export const SOLVER_PORTFOLIO_DISCOVERY_SCENARIOS: SolverPortfolioScenario[] = uniqueScenarios([
  ...FIXED_SAFETY_GRID,
  ...PRODUCT_RERANK_SCENARIOS,
  ...RERANK_SUPPLEMENTAL_SCENARIOS,
]).map((scenario) => ({ ...scenario, cohort: "discovery" }));

const CONFIRMATION_STATES = [
  { id: "R3e400", start: { grade: "R", level: 3, exp: 400 } },
  { id: "R7e1200", start: { grade: "R", level: 7, exp: 1200 } },
  { id: "R12e1800", start: { grade: "R", level: 12, exp: 1800 } },
  { id: "SR3e400", start: { grade: "SR", level: 3, exp: 400 } },
  { id: "SR7e1200", start: { grade: "SR", level: 7, exp: 1200 } },
  { id: "SR12e1800", start: { grade: "SR", level: 12, exp: 1800 } },
] as const satisfies ReadonlyArray<{ id: string; start: CollectionState }>;

const CONFIRMATION_STOCKS = [
  { id: "balanced140", group: "balanced", stock: { blue: 140, purple: 140, yellow: 140 } },
  { id: "balanced220", group: "balanced", stock: { blue: 220, purple: 220, yellow: 220 } },
  { id: "balanced280", group: "balanced", stock: { blue: 280, purple: 280, yellow: 280 } },
  { id: "balanced340", group: "balanced", stock: { blue: 340, purple: 340, yellow: 340 } },
  { id: "skew280-140-60", group: "scarcity", stock: { blue: 280, purple: 140, yellow: 60 } },
  { id: "skew340-280-140", group: "scarcity", stock: { blue: 340, purple: 280, yellow: 140 } },
  { id: "skew220-340-60", group: "scarcity", stock: { blue: 220, purple: 340, yellow: 60 } },
  { id: "gain-shaped470-60-20", group: "scarcity", stock: { blue: 470, purple: 60, yellow: 20 } },
] as const satisfies ReadonlyArray<{
  id: string;
  group: SolverScenario["group"];
  stock: Stock;
}>;

export const SOLVER_PORTFOLIO_CONFIRMATION_SCENARIOS: SolverPortfolioScenario[] =
  CONFIRMATION_STATES.flatMap(({ id: stateId, start }) =>
    CONFIRMATION_STOCKS.map(({ id: stockId, group, stock }) => ({
      id: `confirm-${stateId}-${stockId}`,
      cohort: "confirmation" as const,
      group,
      start: { ...start },
      stock: { ...stock },
    })),
  );

export const SOLVER_PORTFOLIO_SCENARIOS = [
  ...SOLVER_PORTFOLIO_DISCOVERY_SCENARIOS,
  ...SOLVER_PORTFOLIO_CONFIRMATION_SCENARIOS,
];

function uniqueScenarios(scenarios: readonly SolverScenario[]): SolverScenario[] {
  const byId = new Map<string, SolverScenario>();
  for (const scenario of scenarios) byId.set(scenario.id, scenario);
  return [...byId.values()];
}
