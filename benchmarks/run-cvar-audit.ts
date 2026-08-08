import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import type { RustCoreExports } from "../src/wasm/rustTypes";
import { envValue, parseList } from "./runner-utils.ts";
import type { SolverScenario } from "./scenarios/fixed-grid";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/cvar-audit.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const DEFAULT_SCENARIOS = ["R14e900-yellow30"] as const;
const DEFAULT_ETAS = [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6] as const;
const STRICT_EPSILON = 1e-12;

function requireFunction<T extends keyof RustCoreExports>(
  exports: RustCoreExports,
  name: T,
): NonNullable<RustCoreExports[T]> {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`Missing WASM export: ${String(name)}`);
  return value as NonNullable<RustCoreExports[T]>;
}

function parseFiniteNumbers(value: string | undefined, fallback: readonly number[]) {
  const values = parseList(value, fallback.map(String)).map(Number);
  if (values.some((entry) => !Number.isFinite(entry))) {
    throw new Error("CVAR_AUDIT_ETAS must contain only finite comma-separated numbers.");
  }
  return values;
}

function assertStatus(exports: RustCoreExports, operation: string) {
  const status = exports.getSolveStatus?.() ?? 0;
  if (status !== 0) throw new Error(`${operation} failed with solver status ${status}.`);
}

async function instantiate(
  wasm: Uint8Array,
  exportsFromInstance: (instance: WebAssembly.Instance) => RustCoreExports,
) {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return exportsFromInstance(result instanceof WebAssembly.Instance ? result : result.instance);
}

function setup(
  exports: RustCoreExports,
  scenario: SolverScenario,
  encodeState: (grade: string, level: number, exp?: number) => number,
) {
  requireFunction(exports, "cvarSetup")(
    encodeState(scenario.start.grade, scenario.start.level, scenario.start.exp ?? 0),
    scenario.stock.blue | 0,
    scenario.stock.purple | 0,
    scenario.stock.yellow | 0,
    0.75,
    3,
    0,
  );
  assertStatus(exports, "CVaR setup");
}

async function evaluateRawPieceSensitivity(
  wasm: Uint8Array,
  scenario: SolverScenario,
  encodeState: (grade: string, level: number, exp?: number) => number,
  exportsFromInstance: (instance: WebAssembly.Instance) => RustCoreExports,
) {
  const bumpedScenario = {
    ...scenario,
    stock: {
      blue: scenario.stock.blue + 1,
      purple: scenario.stock.purple + 1,
      yellow: scenario.stock.yellow + 1,
    },
  };
  const means = [];
  for (const candidate of [scenario, bumpedScenario]) {
    const exports = await instantiate(wasm, exportsFromInstance);
    setup(exports, candidate, encodeState);
    const mean = requireFunction(exports, "cvarFollowMean")();
    assertStatus(exports, "CVaR raw-piece mean");
    means.push(mean);
  }
  const sameUses = (["blue", "purple", "yellow"] as const).every(
    (kit) => Math.floor(scenario.stock[kit] / 10) === Math.floor(bumpedScenario.stock[kit] / 10),
  );
  return {
    originalStock: scenario.stock,
    bumpedStock: bumpedScenario.stock,
    sameUses,
    originalMean: means[0],
    bumpedMean: means[1],
    delta: (means[1] ?? 0) - (means[0] ?? 0),
    rawPiecesAffectCost: sameUses && Math.abs((means[1] ?? 0) - (means[0] ?? 0)) > STRICT_EPSILON,
  };
}

const alpha = Number(envValue("CVAR_AUDIT_ALPHA") ?? "0.9");
if (!(alpha > 0 && alpha < 1)) throw new Error("CVAR_AUDIT_ALPHA must be between 0 and 1.");
const etas = parseFiniteNumbers(envValue("CVAR_AUDIT_ETAS"), DEFAULT_ETAS);
const scenarioIds = parseList(envValue("CVAR_AUDIT_SCENARIOS"), DEFAULT_SCENARIOS);
const wasm = await readFile(WASM_URL);
await mkdir(RESULTS_DIRECTORY, { recursive: true });

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const core = (await server.ssrLoadModule(
    "/src/wasm/rustCoreShared.ts",
  )) as typeof import("../src/wasm/rustCoreShared");
  const loader = (await server.ssrLoadModule(
    "/src/wasm/rustLoader.ts",
  )) as typeof import("../src/wasm/rustLoader");
  const fixed = (await server.ssrLoadModule(
    "/benchmarks/scenarios/fixed-grid.ts",
  )) as typeof import("./scenarios/fixed-grid");
  const product = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-product.ts",
  )) as typeof import("./scenarios/rerank-product");
  const supplemental = (await server.ssrLoadModule(
    "/benchmarks/scenarios/rerank-supplemental.ts",
  )) as typeof import("./scenarios/rerank-supplemental");
  const allScenarios = [
    ...fixed.FIXED_SAFETY_GRID,
    ...product.PRODUCT_RERANK_SCENARIOS,
    ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS,
  ];
  const byId = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
  const scenarios = scenarioIds.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) throw new Error(`Unknown CVaR audit scenario: ${id}`);
    return scenario;
  });

  const records = [];
  for (const scenario of scenarios) {
    const exports = await instantiate(wasm, loader.rustCoreExportsFromInstance);
    setup(exports, scenario, core.encodeState);
    const baselineMean = requireFunction(exports, "cvarFollowMean")();
    assertStatus(exports, "CVaR baseline mean");
    const baselineMaxSuccess = requireFunction(exports, "rootCandidateMaxSuccessProb")();
    const samples = [];
    for (const eta of etas) {
      const baselineHinge = requireFunction(exports, "cvarFollowHinge")(eta);
      assertStatus(exports, "CVaR baseline hinge");
      const optimizedHinge = requireFunction(exports, "cvarOptRecord")(eta);
      assertStatus(exports, "CVaR optimized hinge");
      const candidateMean = requireFunction(exports, "cvarFollowRecordedMean")();
      assertStatus(exports, "CVaR recorded-policy mean");
      const candidateHinge = requireFunction(exports, "cvarFollowRecordedHinge")(eta);
      assertStatus(exports, "CVaR recorded-policy hinge");
      const candidateSuccess = requireFunction(exports, "cvarFollowRecordedSuccess")();
      assertStatus(exports, "CVaR recorded-policy success");
      const baselineCvar = eta + baselineHinge / (1 - alpha);
      const candidateCvar = eta + candidateHinge / (1 - alpha);
      samples.push({
        eta,
        baselineHinge,
        optimizedHinge,
        candidateHinge,
        baselineCvar,
        candidateCvar,
        candidateMean,
        candidateSuccess,
        successDelta: candidateSuccess - baselineMaxSuccess,
        meanDelta: candidateMean - baselineMean,
        cvarDelta: candidateCvar - baselineCvar,
        nodeCount: requireFunction(exports, "cvarNodeCount")(),
      });
    }
    const bestSample = samples.reduce((best, sample) =>
      sample.candidateCvar < best.candidateCvar ? sample : best,
    );
    records.push({
      scenario,
      baselineMean,
      baselineMaxSuccess,
      samples,
      bestSample,
      rawPieceSensitivity: await evaluateRawPieceSensitivity(
        wasm,
        scenario,
        core.encodeState,
        loader.rustCoreExportsFromInstance,
      ),
      productAssessment: {
        grade: "verification_incomplete",
        reasons: [
          "This ABI audit does not perform the exact interactive-replan product gate; see the gated CVaR study.",
          "The eta grid is sampled and does not prove the continuous dual optimum.",
        ],
        sampledMeanNonWorse: bestSample.meanDelta <= STRICT_EPSILON,
        sampledTailImproved: bestSample.cvarDelta < -STRICT_EPSILON,
      },
    });
  }

  const report = {
    kind: "cvar-abi-audit",
    version: 1,
    generatedAt: new Date().toISOString(),
    options: {
      alpha,
      etas,
      scenarioIds,
      horizonFactor: 0.75,
      normPower: 3,
      tolerance: 0,
    },
    staticContract: {
      rawPiecesPassedToSetup: true,
      successProbabilityGateEnforcedByOptimizer: true,
      recordedPolicyActionExportAvailable: true,
      productRuntimeChanged: false,
    },
    records,
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        kind: report.kind,
        options: report.options,
        records: records.map((record) => ({
          scenarioId: record.scenario.id,
          baselineMean: record.baselineMean,
          bestSample: record.bestSample,
          rawPieceSensitivity: record.rawPieceSensitivity,
          productAssessment: record.productAssessment,
        })),
        output: OUTPUT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
