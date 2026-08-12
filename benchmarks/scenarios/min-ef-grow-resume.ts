import type { CollectionState, Stock } from "../../src/types";
import type { SolverScenario } from "./fixed-grid";
import {
  SOLVER_PORTFOLIO_CONFIRMATION_SCENARIOS,
  SOLVER_PORTFOLIO_DISCOVERY_SCENARIOS,
} from "./solver-portfolio.ts";
import { SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS } from "./solver-portfolio-validation.ts";

export type MinEfGrowResumeCohort = "confirmation" | "discovery" | "held-out" | "validation";

export type MinEfGrowResumeScenario = SolverScenario & {
  cohort: MinEfGrowResumeCohort;
};

const HELD_OUT_STATES = [
  { id: "R1e200", start: { grade: "R", level: 1, exp: 200 } },
  { id: "R5e800", start: { grade: "R", level: 5, exp: 800 } },
  { id: "R9e1500", start: { grade: "R", level: 9, exp: 1500 } },
  { id: "SR2e300", start: { grade: "SR", level: 2, exp: 300 } },
] as const satisfies ReadonlyArray<{ id: string; start: CollectionState }>;

const HELD_OUT_STOCKS = [
  { id: "balanced190", group: "balanced", stock: { blue: 190, purple: 190, yellow: 190 } },
  { id: "balanced260", group: "balanced", stock: { blue: 260, purple: 260, yellow: 260 } },
  { id: "balanced320", group: "balanced", stock: { blue: 320, purple: 320, yellow: 320 } },
  { id: "skew260-180-90", group: "scarcity", stock: { blue: 260, purple: 180, yellow: 90 } },
  {
    id: "skew380-210-120",
    group: "scarcity",
    stock: { blue: 380, purple: 210, yellow: 120 },
  },
  {
    id: "gain-shaped430-95-35",
    group: "scarcity",
    stock: { blue: 430, purple: 95, yellow: 35 },
  },
] as const satisfies ReadonlyArray<{
  id: string;
  group: SolverScenario["group"];
  stock: Stock;
}>;

export const MIN_EF_GROW_RESUME_HELD_OUT_SCENARIOS: MinEfGrowResumeScenario[] =
  HELD_OUT_STATES.flatMap(({ id: stateId, start }) =>
    HELD_OUT_STOCKS.map(({ id: stockId, group, stock }) => ({
      id: `grow-resume-${stateId}-${stockId}`,
      cohort: "held-out" as const,
      group,
      start: { ...start },
      stock: { ...stock },
    })),
  );

export const MIN_EF_GROW_RESUME_SCENARIOS: MinEfGrowResumeScenario[] = [
  ...SOLVER_PORTFOLIO_DISCOVERY_SCENARIOS,
  ...SOLVER_PORTFOLIO_CONFIRMATION_SCENARIOS,
  ...SOLVER_PORTFOLIO_ROUTING_VALIDATION_SCENARIOS.map((scenario) => ({
    ...scenario,
    cohort: "validation" as const,
  })),
  ...MIN_EF_GROW_RESUME_HELD_OUT_SCENARIOS,
];
