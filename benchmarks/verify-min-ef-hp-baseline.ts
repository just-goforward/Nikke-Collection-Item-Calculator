import { readFile } from "node:fs/promises";
import { createServer } from "vite";

import { readHpStudyReport, writeHpStudyReport } from "./min-ef-hp-report.ts";

const REPORT_FILE = new URL("./results/min-ef-hp-study.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const wasm = await readFile(WASM_URL);
const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});

try {
  const model = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-model.ts",
  )) as typeof import("./min-ef-hp-model");
  const hpPolicy = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-policy.ts",
  )) as typeof import("./min-ef-hp-policy");
  const rustLoader = (await server.ssrLoadModule(
    "/src/wasm/rustLoader.ts",
  )) as typeof import("../src/wasm/rustLoader");
  const rustMinEf = (await server.ssrLoadModule(
    "/src/wasm/rustMinEfCore.ts",
  )) as typeof import("../src/wasm/rustMinEfCore");
  const rustPhase2 = (await server.ssrLoadModule(
    "/src/wasm/rustPhase2Core.ts",
  )) as typeof import("../src/wasm/rustPhase2Core");
  const evaluator = (await server.ssrLoadModule(
    "/benchmarks/evaluator/exact-replan.ts",
  )) as typeof import("./evaluator/exact-replan");

  const baseline = model.hpCandidateById(model.HP_BASELINE_ID);
  const notes: string[] = [];

  const minEfInput = {
    start: { grade: "SR" as const, level: 10, exp: 0 },
    stock: { blue: 101, purple: 109, yellow: 119 },
    strategy: "supply" as const,
  };
  const minEfSession = await createSession(wasm, baseline, hpPolicy.createHpLadderSession);
  const minEfReferenceInstance = await instantiate(wasm);
  const minEfReference = rustMinEf.createRustMinEfSolver(
    rustLoader.rustCoreExportsFromInstance(minEfReferenceInstance),
  );
  minEfReference.configureMemoTier(21);
  const minEfScreen = minEfSession.screenRoot(minEfInput, "raw-remainder");
  const minEfRoot = minEfReference.solveRootWithCandidates(
    minEfInput.start,
    minEfInput.stock,
    0.75,
    3,
    0,
  ).root;
  assertRootEqual(minEfScreen.metrics, minEfRoot, "min-E[f] raw remainder baseline");
  if (minEfScreen.selectedBackend !== "rust-min-ef") {
    throw new Error("Baseline min-E[f] fixture did not use rust-min-ef.");
  }
  notes.push("raw remainder min-E[f] root is bit-identical to the current product wrapper");
  minEfSession.release();
  minEfReference.releaseMemo();

  const phase2Input = {
    start: { grade: "R" as const, level: 0, exp: 0 },
    stock: { blue: 300, purple: 300, yellow: 300 },
    strategy: "supply" as const,
  };
  const phase2Session = await createSession(wasm, baseline, hpPolicy.createHpLadderSession);
  const phase2ReferenceInstance = await instantiate(wasm);
  const phase2Reference = rustPhase2.createRustPhase2Solver(
    rustLoader.rustCoreExportsFromInstance(phase2ReferenceInstance),
  );
  phase2Reference.configureMemoTier(22);
  const phase2Screen = phase2Session.screenRoot(phase2Input, "phase2-fallback");
  const phase2Policy = phase2Reference.buildPolicy(
    phase2Input.start,
    phase2Input.stock,
    0.75,
    3,
    0,
  );
  const phase2Root = phase2Policy.root;
  const phase2ExpectedCost = phase2Policy.candidates.find(
    (candidate) => candidate.firstAction === phase2Root.firstAction,
  )?.resourceCost;
  if (phase2ExpectedCost === undefined) {
    throw new Error("Phase2 baseline root has no matching candidate cost.");
  }
  assertRootEqual(
    phase2Screen.metrics,
    { ...phase2Root, expectedCost: phase2ExpectedCost },
    "phase2 fallback baseline",
  );
  if (phase2Screen.minEfOutcome !== "memo_full" || phase2Screen.selectedBackend !== "rust-phase2") {
    throw new Error("Baseline fallback fixture did not preserve the min-E[f] to phase2 ladder.");
  }
  notes.push("R0-balanced300 falls back from min-E[f] tier 21 to bit-identical phase2 tier 22");
  phase2Session.release();
  phase2Reference.releaseMemo();

  const flowSession = await createSession(wasm, baseline, hpPolicy.createHpLadderSession);
  const conversion = evaluator.evaluateExactInteractiveReplan(
    {
      id: "R15-conversion-baseline",
      group: "balanced",
      start: { grade: "R", level: 15, exp: 0 },
      stock: { blue: 100, purple: 100, yellow: 100 },
    },
    {
      modelId: baseline.id,
      policySolver: flowSession.policySolver,
      toleranceOverride: 0,
      timeBudgetMs: 120_000,
    },
  );
  if (conversion.status !== "completed") {
    throw new Error(`R15 conversion fixture did not complete: ${conversion.status}`);
  }
  notes.push("exact interactive evaluation preserves R15 to SR5 conversion");
  flowSession.release();

  const report = await readHpStudyReport(REPORT_FILE);
  if (report) {
    report.baselineVerification = { candidateId: baseline.id, status: "passed", notes };
    await writeHpStudyReport(REPORT_FILE, report);
  }
  console.log(JSON.stringify({ candidateId: baseline.id, status: "passed", notes }, null, 2));
} finally {
  await server.close();
}

async function createSession(
  bytes: Uint8Array,
  candidate: import("./min-ef-hp-model").HpCandidate,
  factory: typeof import("./min-ef-hp-policy").createHpLadderSession,
) {
  const [minEfInstance, phase2Instance] = await Promise.all([
    instantiate(bytes),
    instantiate(bytes),
  ]);
  return factory(minEfInstance, phase2Instance, candidate);
}

async function instantiate(bytes: Uint8Array): Promise<WebAssembly.Instance> {
  const result = (await WebAssembly.instantiate(bytes)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}

function assertRootEqual(
  actual: import("./min-ef-hp-model").HpRootMetrics | null,
  expected: {
    firstAction: unknown;
    successProbability: number;
    maxSuccessProbability: number;
    vector: { blue: number; purple: number; yellow: number };
    states: number;
    expectedCost?: number;
  },
  label: string,
): void {
  if (!actual) throw new Error(`${label} produced no metrics.`);
  if (
    actual.firstAction !== expected.firstAction ||
    actual.successProbability !== expected.successProbability ||
    actual.maxSuccessProbability !== expected.maxSuccessProbability ||
    actual.expectedConsumption.blue !== expected.vector.blue ||
    actual.expectedConsumption.purple !== expected.vector.purple ||
    actual.expectedConsumption.yellow !== expected.vector.yellow ||
    actual.optimizerExpectedCost !== expected.expectedCost ||
    actual.nodeCount !== expected.states
  ) {
    throw new Error(`${label} differs from the current product solver.`);
  }
}
