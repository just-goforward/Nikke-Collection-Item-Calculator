import type { CollectionState, Stock } from "../../src/types";
import type { SolverScenario } from "./fixed-grid";

export type ProductRerankScenarioSource = "product-observed" | "product-observed-high-stock";

export type ProductRerankScenario = SolverScenario & {
  productSource: ProductRerankScenarioSource;
};

const PRODUCT_RERANK_STATES = [
  { id: "R0", start: { grade: "R", level: 0, exp: 0 } },
  { id: "SR0", start: { grade: "SR", level: 0, exp: 0 } },
  { id: "SR5", start: { grade: "SR", level: 5, exp: 0 } },
  { id: "SR10", start: { grade: "SR", level: 10, exp: 0 } },
  { id: "SR14e2900", start: { grade: "SR", level: 14, exp: 2900 } },
] as const satisfies ReadonlyArray<{ id: string; start: CollectionState }>;

// Product-judgement panels based on production diagnostic buckets as of 2026-06-06.
// These are solve-event bucket aggregates, not unique-user telemetry. Yellow 300+ remains an edge
// case in fixed-grid; purple 300+ is kept as a separate high-stock stress source because aggregate
// events can be inflated by repeated calculations from a small number of users.
const PRODUCT_RERANK_STOCKS = [
  {
    id: "observedCore",
    group: "balanced",
    productSource: "product-observed",
    stock: { blue: 300, purple: 150, yellow: 70 },
  },
  {
    id: "observedBalanced",
    group: "balanced",
    productSource: "product-observed",
    stock: { blue: 300, purple: 150, yellow: 150 },
  },
  {
    id: "observedPurpleHigh",
    group: "balanced",
    productSource: "product-observed-high-stock",
    stock: { blue: 350, purple: 300, yellow: 150 },
  },
  {
    id: "observedYellowLow",
    group: "scarcity",
    productSource: "product-observed",
    stock: { blue: 300, purple: 150, yellow: 30 },
  },
  {
    id: "observedLowKits",
    group: "scarcity",
    productSource: "product-observed",
    stock: { blue: 300, purple: 70, yellow: 30 },
  },
] as const satisfies ReadonlyArray<{
  id: string;
  group: SolverScenario["group"];
  productSource: ProductRerankScenarioSource;
  stock: Stock;
}>;

const STATE_IDS_BY_STOCK = {
  observedCore: new Set(["R0", "SR0", "SR5", "SR10"]),
  observedBalanced: new Set(["R0", "SR0", "SR10"]),
  observedPurpleHigh: new Set(["SR0", "SR5", "SR10", "SR14e2900"]),
  observedYellowLow: new Set(["R0", "SR0", "SR5", "SR10"]),
  observedLowKits: new Set(["R0", "SR0", "SR10"]),
} as const;

function makeScenario(
  stateId: string,
  start: CollectionState,
  stockId: string,
  group: SolverScenario["group"],
  productSource: ProductRerankScenarioSource,
  stock: Stock,
): ProductRerankScenario {
  return {
    id: `${stateId}-${stockId}`,
    group,
    productSource,
    start: { ...start },
    stock: { ...stock },
  };
}

export const PRODUCT_RERANK_SCENARIOS: ProductRerankScenario[] = PRODUCT_RERANK_STOCKS.flatMap(
  ({ id: stockId, group, productSource, stock }) =>
    PRODUCT_RERANK_STATES.filter(({ id: stateId }) => STATE_IDS_BY_STOCK[stockId].has(stateId)).map(
      ({ id: stateId, start }) =>
        makeScenario(stateId, start, stockId, group, productSource, stock),
    ),
);
