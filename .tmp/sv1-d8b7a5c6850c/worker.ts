// Per-case evaluation: product current (Rust/WASM production backend and the JS
// FiniteKernel backend) versus the independent oracle via the existing lane
// comparison (verifyCurrent / verifyBatch) plus a direct solveOracle cross-check.
import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";

await import("./hooks.mjs");
const ROOT = "../../";
const rational = await import(`${ROOT}shared/certifiedRational.ts`);
const { CertifiedLimit, WorkBudget } = await import(`${ROOT}src/certified/budget.ts`);
const { encode } = await import(`${ROOT}src/certified/game.ts`);
const { FiniteKernel } = await import(`${ROOT}src/certified/kernel.ts`);
const { currentView } = await import(`${ROOT}src/certified/current.ts`);
const { loadCertifiedWasm, WasmKernel } = await import(`${ROOT}src/certified/wasmBackend.ts`);
const oracle = await import(`${ROOT}scripts/certified-staging-oracle.ts`);
const lane = await import(`${ROOT}scripts/certified-staging-oracle-lane.ts`);

const module = await loadCertifiedWasm(() => readFile("public/certified_solver.wasm"));
const KITS = ["blue", "purple", "yellow"] as const;
const SOLVE_ORACLE_MAX_USES = 24;

type Wire = { numerator: string; denominator: string };
type Case = {
  id: number;
  stratum: string;
  grade: "R" | "SR";
  level: number;
  exp: number;
  stock: [number, number, number];
  prices: [Wire, Wire, Wire];
  batchLimit?: number;
};
type Check = { status: "PASS" | "FAIL" | "NOTRUN"; reason: string };

function productRun(kind: "wasm" | "js", c: Case) {
  const started = performance.now();
  const weights = c.prices.map(rational.fromWire);
  const sid = encode(c.grade, c.level, c.exp);
  const input = { grade: c.grade, level: c.level, exp: c.exp, stock: c.stock, batchLimit: c.batchLimit };
  const budget = new WorkBudget({}, performance.now());
  try {
    if (kind === "wasm") {
      const kernel = new WasmKernel(module, budget);
      try {
        kernel.initialize(weights);
        return { current: kernel.current(sid, input), ms: performance.now() - started };
      } finally {
        kernel.dispose();
      }
    }
    const kernel = new FiniteKernel(weights, budget);
    const root = kernel.solve(sid, c.stock);
    const current = currentView(sid, input, root, kernel);
    kernel.releaseTemporaryBounds();
    return { current, ms: performance.now() - started };
  } catch (error) {
    if (error instanceof CertifiedLimit)
      return { current: null, refusal: error.reason, ms: performance.now() - started };
    throw error;
  }
}

function solveOracleCheck(c: Case, current: any, prices: any): Check {
  const uses = c.stock.reduce((n, pieces) => n + Math.floor(pieces / 10), 0);
  if (uses > SOLVE_ORACLE_MAX_USES)
    return { status: "NOTRUN", reason: `solveOracle_not_admitted_uses_${uses}_gt_${SOLVE_ORACLE_MAX_USES}` };
  const expected = oracle.solveOracle({ grade: c.grade, level: c.level, exp: c.exp, stock: c.stock, prices });
  const actual = {
    P: oracle.fromWire(current.value.successP),
    B: oracle.fromWire(current.value.weightedExpectedConsumptionB),
    C: oracle.fromWire(current.value.expectedTotalConsumptionC),
  };
  if (oracle.compareValue(actual, expected) !== 0 || !oracle.equalValue(actual, expected))
    return { status: "FAIL", reason: "solveOracle_PBC_mismatch" };
  const consumed = current.value.expectedConsumed.map(oracle.fromWire);
  if (!consumed.every((value: any, k: number) => oracle.cmp(value, expected.consumed[k]) === 0))
    return { status: "FAIL", reason: "solveOracle_consumed_mismatch" };
  const mask = KITS.reduce((m, kit, k) => (expected.ties.includes(kit) ? m | (1 << k) : m), 0);
  if (current.optimalActionMask !== mask) return { status: "FAIL", reason: "solveOracle_mask_mismatch" };
  const firstKit = KITS.find((kit) => expected.ties.includes(kit)) ?? null;
  if (current.kit !== firstKit) return { status: "FAIL", reason: "solveOracle_kit_mismatch" };
  return { status: "PASS", reason: `solveOracle_exact_nodes_${expected.nodes}` };
}

function evaluate(c: Case) {
  const started = performance.now();
  const prices = c.prices.map(oracle.fromWire);
  const state = { grade: c.grade, level: c.level, exp: c.exp, stock: c.stock };
  const wasm = productRun("wasm", c);
  const js = productRun("js", c);
  const checks: Record<string, Check> = {};
  let expected: any;
  if (!wasm.current) {
    checks.currentWasm = { status: "NOTRUN", reason: `product_wasm_refused:${wasm.refusal}` };
  } else {
    const verdict = lane.verifyCurrent(state, { status: "partial", current: wasm.current } as any, prices);
    checks.currentWasm = verdict.check;
    expected = verdict.expected;
    checks.batchWasm = expected
      ? lane.verifyBatch({ ...state, batchLimit: c.batchLimit }, wasm.current, prices, expected)
      : { status: "NOTRUN", reason: "batch_requires_independent_current" };
    checks.solveOracleWasm = solveOracleCheck(c, wasm.current, prices);
  }
  if (!js.current) {
    checks.currentJs = { status: "NOTRUN", reason: `product_js_refused:${js.refusal}` };
  } else if (wasm.current && JSON.stringify(js.current) === JSON.stringify(wasm.current)) {
    checks.currentJs = { ...checks.currentWasm, reason: `identical_to_wasm:${checks.currentWasm.reason}` };
  } else {
    const verdict = lane.verifyCurrent(state, { status: "partial", current: js.current } as any, prices);
    checks.currentJs = verdict.check;
    if (verdict.expected)
      checks.batchJs = lane.verifyBatch({ ...state, batchLimit: c.batchLimit }, js.current, prices, verdict.expected);
    checks.solveOracleJs = solveOracleCheck(c, js.current, prices);
  }
  // solveOracle is a supplementary second oracle: its non-admission (> max uses)
  // does not downgrade the case; its FAIL does.
  const statuses = Object.entries(checks)
    .filter(([name, check]) => !(name.startsWith("solveOracle") && check.status === "NOTRUN"))
    .map(([, check]) => check.status);
  let status: Check["status"] = "PASS";
  if (statuses.includes("FAIL")) status = "FAIL";
  else if (statuses.includes("NOTRUN")) status = "NOTRUN";
  const endpointStatuses = [checks.currentWasm.status, checks.currentJs.status];
  let endpoint: Check["status"] = "PASS";
  if (endpointStatuses.includes("FAIL")) endpoint = "FAIL";
  else if (endpointStatuses.includes("NOTRUN")) endpoint = "NOTRUN";
  return {
    ...c,
    status,
    endpoint,
    checks,
    expected: expected && {
      P: oracle.wire(expected.P),
      B: oracle.wire(expected.B),
      C: oracle.wire(expected.C),
      consumed: expected.consumed.map(oracle.wire),
      ties: expected.ties,
      action: expected.action,
    },
    wasm: { current: wasm.current, refusal: wasm.refusal ?? null, ms: Math.round(wasm.ms) },
    js: { current: js.current, refusal: js.refusal ?? null, ms: Math.round(js.ms) },
    ms: Math.round(performance.now() - started),
  };
}

parentPort?.on("message", (c: Case) => {
  try {
    parentPort?.postMessage({ ok: true, record: evaluate(c) });
  } catch (error) {
    parentPort?.postMessage({ ok: false, id: c.id, error: String((error as Error)?.stack ?? error) });
  }
});
parentPort?.postMessage({ ready: true });
