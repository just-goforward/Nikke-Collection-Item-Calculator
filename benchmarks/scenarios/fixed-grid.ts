import type { CollectionState, Stock } from "../../src/types";

export type ScenarioGroup = "balanced" | "scarcity";

export type SolverScenario = {
  id: string;
  group: ScenarioGroup;
  start: CollectionState;
  stock: Stock;
};

const STATES = [
  { id: "R0", start: { grade: "R", level: 0, exp: 0 } },
  { id: "R10", start: { grade: "R", level: 10, exp: 0 } },
  { id: "R14e900", start: { grade: "R", level: 14, exp: 900 } },
  { id: "SR0", start: { grade: "SR", level: 0, exp: 0 } },
  { id: "SR5", start: { grade: "SR", level: 5, exp: 0 } },
  { id: "SR10", start: { grade: "SR", level: 10, exp: 0 } },
  { id: "SR10e2900", start: { grade: "SR", level: 10, exp: 2900 } },
  { id: "SR14e2900", start: { grade: "SR", level: 14, exp: 2900 } },
] as const satisfies ReadonlyArray<{ id: string; start: CollectionState }>;

const STOCKS = [
  { id: "balanced30", group: "balanced", stock: { blue: 30, purple: 30, yellow: 30 } },
  { id: "balanced100", group: "balanced", stock: { blue: 100, purple: 100, yellow: 100 } },
  { id: "balanced300", group: "balanced", stock: { blue: 300, purple: 300, yellow: 300 } },
  { id: "blue10", group: "scarcity", stock: { blue: 10, purple: 100, yellow: 100 } },
  { id: "purple10", group: "scarcity", stock: { blue: 100, purple: 10, yellow: 100 } },
  { id: "yellow10", group: "scarcity", stock: { blue: 100, purple: 100, yellow: 10 } },
  { id: "blue30", group: "scarcity", stock: { blue: 30, purple: 100, yellow: 100 } },
  { id: "purple30", group: "scarcity", stock: { blue: 100, purple: 30, yellow: 100 } },
  { id: "yellow30", group: "scarcity", stock: { blue: 100, purple: 100, yellow: 30 } },
  { id: "skewBlue", group: "scarcity", stock: { blue: 200, purple: 30, yellow: 10 } },
  { id: "skewPurple", group: "scarcity", stock: { blue: 30, purple: 200, yellow: 10 } },
  { id: "skewYellow", group: "scarcity", stock: { blue: 30, purple: 10, yellow: 200 } },
] as const satisfies ReadonlyArray<{ id: string; group: ScenarioGroup; stock: Stock }>;

export const FIXED_SAFETY_GRID: SolverScenario[] = STATES.flatMap(({ id: stateId, start }) =>
  STOCKS.map(({ id: stockId, group, stock }) => ({
    id: `${stateId}-${stockId}`,
    group,
    start: { ...start },
    stock: { ...stock },
  })),
);

export const BALANCED_SET = FIXED_SAFETY_GRID.filter((scenario) => scenario.group === "balanced");
export const SCARCITY_SET = FIXED_SAFETY_GRID.filter((scenario) => scenario.group === "scarcity");

const REQUIRED_SENTINEL_IDS = new Set([
  "R0-balanced100",
  "SR0-balanced100",
  "R14e900-yellow30",
  "R0-balanced300",
  "SR0-balanced300",
]);

export const REQUIRED_SENTINELS = FIXED_SAFETY_GRID.filter((scenario) =>
  REQUIRED_SENTINEL_IDS.has(scenario.id),
);
