import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Stock = { blue: number; purple: number; yellow: number };
type CollectionState = { grade: "R" | "SR"; level: number; exp: number };
type StudyScenario = {
  id: string;
  memoTier: number;
  start: CollectionState;
  stock: Stock;
};
type MinEfExports = {
  configureMinEfMemo?: (tier: number) => void;
  configureMinEfTraversalOrder?: (orderCode: number) => number;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus?: () => number;
  minEfAction?: () => number;
  minEfExpectedCost?: () => number;
  minEfNodeCount?: () => number;
  minEfSuccessProb?: () => number;
  solveMinEf?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
};

const WASM_PATH = resolve("public", "solver_rs.wasm");
const OUTPUT_PATH = resolve("benchmarks", "results", "min-ef-action-order-study.json");
const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;
const SCENARIOS: StudyScenario[] = [
  {
    id: "semantic-dominance-cap-tier21",
    memoTier: 21,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 60, purple: 120, yellow: 900 },
  },
  {
    id: "R0-balanced250-tier21",
    memoTier: 21,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 250, purple: 250, yellow: 250 },
  },
  {
    id: "R0-balanced250-tier22",
    memoTier: 22,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 250, purple: 250, yellow: 250 },
  },
  {
    id: "R0-balanced300-tier22",
    memoTier: 22,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 300, purple: 300, yellow: 300 },
  },
  {
    id: "SR0-observedPurpleHigh-tier22",
    memoTier: 22,
    start: { grade: "SR", level: 0, exp: 0 },
    stock: { blue: 350, purple: 300, yellow: 150 },
  },
  {
    id: "R0-skewed-tier22",
    memoTier: 22,
    start: { grade: "R", level: 0, exp: 0 },
    stock: { blue: 880, purple: 439, yellow: 111 },
  },
];

function requireFunction<T extends (...args: never[]) => unknown>(
  value: T | undefined,
  name: string,
): T {
  if (typeof value !== "function") throw new Error(`WASM export ${name} is missing.`);
  return value;
}

function outcome(status: number) {
  if (status === 0) return "completed";
  if (status === 1) return "budget_exceeded";
  if (status === 2) return "memo_full";
  return "failure";
}

function bits(value: number) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, true);
  return `0x${view.getBigUint64(0, true).toString(16).padStart(16, "0")}`;
}

function stateId(state: CollectionState) {
  return (((state.grade === "SR" ? 1 : 0) * 16 + state.level) * 30 + state.exp / 100) | 0;
}

async function instantiate(module: WebAssembly.Module, memoTier: number, orderCode: number) {
  const instance = await WebAssembly.instantiate(module);
  const exports = instance.exports as MinEfExports;
  requireFunction(exports.configureMinEfMemo, "configureMinEfMemo")(memoTier);
  requireFunction(exports.configureMinEfTraversalOrder, "configureMinEfTraversalOrder")(orderCode);
  exports.configureNodeBudget?.(20_000_000);
  return exports;
}

const module = await WebAssembly.compile(await readFile(WASM_PATH));
const records = [];
for (let orderCode = 0; orderCode < ORDERS.length; orderCode += 1) {
  const order = ORDERS[orderCode];
  if (!order) throw new Error(`Missing traversal order ${orderCode}.`);
  for (const scenario of SCENARIOS) {
    const exports = await instantiate(module, scenario.memoTier, orderCode);
    const solve = requireFunction(exports.solveMinEf, "solveMinEf");
    const startedAt = performance.now();
    solve(
      stateId(scenario.start),
      scenario.stock.blue,
      scenario.stock.purple,
      scenario.stock.yellow,
      0.75,
      3,
      0,
    );
    const elapsedMs = performance.now() - startedAt;
    const status = requireFunction(exports.getSolveStatus, "getSolveStatus")();
    const solveOutcome = outcome(status);
    records.push({
      action: status === 0 ? requireFunction(exports.minEfAction, "minEfAction")() : null,
      elapsedMs,
      expectedCostBits:
        status === 0
          ? bits(requireFunction(exports.minEfExpectedCost, "minEfExpectedCost")())
          : null,
      nodeCount: requireFunction(exports.minEfNodeCount, "minEfNodeCount")(),
      order: [...order],
      orderCode,
      outcome: solveOutcome,
      scenarioId: scenario.id,
      successBits:
        status === 0 ? bits(requireFunction(exports.minEfSuccessProb, "minEfSuccessProb")()) : null,
    });
    console.log(
      `${scenario.id} order=${order.join("")} ${solveOutcome} nodes=${records.at(-1)?.nodeCount} ${elapsedMs.toFixed(1)}ms`,
    );
  }
}

const baselineByScenario = new Map(
  records.filter((record) => record.orderCode === 0).map((record) => [record.scenarioId, record]),
);
for (const record of records) {
  if (record.outcome !== "completed") continue;
  const baseline = baselineByScenario.get(record.scenarioId);
  if (baseline?.outcome !== "completed") continue;
  if (
    record.action !== baseline.action ||
    record.successBits !== baseline.successBits ||
    record.expectedCostBits !== baseline.expectedCostBits
  ) {
    throw new Error(
      `${record.scenarioId} order ${record.order.join("")} changed solver semantics.`,
    );
  }
}

await writeFile(
  OUTPUT_PATH,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      kind: "min-ef-action-order-study",
      records,
      scenarios: SCENARIOS,
      version: 1,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`Wrote ${OUTPUT_PATH}`);
