import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

import type { RustCoreExports } from "../src/wasm/rustTypes";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

type ClosureMode = "phase2_policy" | "one_sweep" | "full_eligible";
type UsesState = { sid: number; blue: number; purple: number; yellow: number };

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const OUTPUT_FILE = new URL("./results/phase2-successor-closure.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const DEFAULT_SCENARIOS = ["R14e900-yellow30", "R10-balanced300"] as const;
const BLUE_DIMENSION = 221;
const PURPLE_DIMENSION = 89;
const YELLOW_DIMENSION = 45;
const STRICT_EPSILON = 1e-12;

function requireFunction<T extends keyof RustCoreExports>(
  exports: RustCoreExports,
  name: T,
): NonNullable<RustCoreExports[T]> {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`Missing WASM export: ${String(name)}`);
  return value as NonNullable<RustCoreExports[T]>;
}

function pack(state: UsesState) {
  return (
    ((state.sid * BLUE_DIMENSION + state.blue) * PURPLE_DIMENSION + state.purple) *
      YELLOW_DIMENSION +
    state.yellow
  );
}

function unpack(key: number): UsesState {
  const yellow = key % YELLOW_DIMENSION;
  const withoutYellow = (key - yellow) / YELLOW_DIMENSION;
  const purple = withoutYellow % PURPLE_DIMENSION;
  const withoutPurple = (withoutYellow - purple) / PURPLE_DIMENSION;
  const blue = withoutPurple % BLUE_DIMENSION;
  const sid = (withoutPurple - blue) / BLUE_DIMENSION;
  return { sid, blue, purple, yellow };
}

function decrement(state: UsesState, action: number): UsesState {
  return {
    ...state,
    blue: state.blue - Number(action === 0),
    purple: state.purple - Number(action === 1),
    yellow: state.yellow - Number(action === 2),
  };
}

const scenarioIds = parseList(envValue("PHASE2_CLOSURE_SCENARIOS"), DEFAULT_SCENARIOS);
const maxStates = parsePositiveInteger(envValue("PHASE2_CLOSURE_MAX_STATES"), 2_000_000);
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
  const domain = (await server.ssrLoadModule(
    "/src/solver/domain.ts",
  )) as typeof import("../src/solver/domain");
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
  const byId = new Map(
    [
      ...fixed.FIXED_SAFETY_GRID,
      ...product.PRODUCT_RERANK_SCENARIOS,
      ...supplemental.RERANK_SUPPLEMENTAL_SCENARIOS,
    ].map((scenario) => [scenario.id, scenario]),
  );

  function closure(
    exports: RustCoreExports,
    start: UsesState,
    mode: ClosureMode,
    baselineStates?: ReadonlySet<number>,
  ) {
    const actionAt = requireFunction(exports, "policyActionAt");
    const successForAction = requireFunction(exports, "phase2MaxSuccessForActionAt");
    const seen = new Set<number>();
    const queue: number[] = [];
    const add = (state: UsesState) => {
      const key = pack(state);
      if (seen.has(key)) return;
      seen.add(key);
      queue.push(key);
    };
    if (mode === "one_sweep" && baselineStates) {
      for (const key of baselineStates) add(unpack(key));
    } else {
      add(start);
    }
    let cursor = 0;
    let truncated = false;
    while (cursor < queue.length) {
      if (seen.size >= maxStates) {
        truncated = true;
        break;
      }
      const state = unpack(queue[cursor] as number);
      cursor += 1;
      const decoded = {
        grade: state.sid >= 480 ? ("SR" as const) : ("R" as const),
        level: Math.floor(state.sid / 30) % 16,
        exp: (state.sid % 30) * 100,
      };
      if (domain.isTerminalNormalized(decoded)) continue;
      if (domain.isConvertStateNormalized(decoded)) {
        add({ ...state, sid: domain.stateIdNormalized(domain.convertState()) });
        continue;
      }

      let actions: number[];
      const isBaselineState = baselineStates?.has(pack(state)) ?? false;
      if (mode === "phase2_policy" || (mode === "one_sweep" && !isBaselineState)) {
        const action = actionAt(state.sid, state.blue, state.purple, state.yellow);
        actions = action >= 0 ? [action] : [];
      } else {
        const success = [0, 1, 2].map((action) =>
          successForAction(state.sid, state.blue, state.purple, state.yellow, action),
        );
        const maximum = Math.max(...success);
        actions = success.flatMap((value, action) =>
          value >= 0 && maximum - value <= STRICT_EPSILON ? [action] : [],
        );
      }
      for (const action of actions) {
        const kit = domain.KIT_ORDER[action];
        if (!kit || state[kit] <= 0) continue;
        const edge = domain.transitionNormalized(decoded, kit);
        const nextStock = decrement(state, action);
        add({ ...nextStock, sid: domain.stateIdNormalized(edge.success) });
        add({ ...nextStock, sid: domain.stateIdNormalized(edge.fail) });
      }
    }
    return { keys: seen, states: seen.size, truncated };
  }

  const records = [];
  for (const scenarioId of scenarioIds) {
    const scenario = byId.get(scenarioId);
    if (!scenario) throw new Error(`Unknown closure scenario: ${scenarioId}`);
    const result = (await WebAssembly.instantiate(wasm)) as
      | WebAssembly.Instance
      | { instance: WebAssembly.Instance };
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const exports = loader.rustCoreExportsFromInstance(instance) as RustCoreExports;
    requireFunction(exports, "configureMemo")(22);
    requireFunction(exports, "cvarSetup")(
      domain.stateIdNormalized(scenario.start),
      scenario.stock.blue,
      scenario.stock.purple,
      scenario.stock.yellow,
      0.75,
      3,
      0,
    );
    const status = exports.getSolveStatus?.() ?? 0;
    if (status !== 0) {
      records.push({ scenarioId, setupStatus: status });
      continue;
    }
    const uses = domain.clampMemoStockUses(domain.stockToUses(scenario.stock));
    const start = { sid: domain.stateIdNormalized(scenario.start), ...uses };
    const baseline = closure(exports, start, "phase2_policy");
    const sweeps = [];
    let previous = baseline;
    for (let sweep = 1; sweep <= 4; sweep += 1) {
      const expanded = closure(exports, start, "one_sweep", previous.keys);
      sweeps.push({ sweep, states: expanded.states, truncated: expanded.truncated });
      previous = expanded;
      if (expanded.truncated || expanded.states === (sweeps.at(-2)?.states ?? baseline.states)) {
        break;
      }
    }
    const oneSweep = sweeps[0];
    if (!oneSweep) throw new Error(`Missing first successor sweep for ${scenarioId}.`);
    const full = closure(exports, start, "full_eligible");
    records.push({
      scenarioId,
      setupStatus: status,
      phase2PolicyStates: baseline.states,
      oneSweepStates: oneSweep.states,
      oneSweepTruncated: oneSweep.truncated,
      sweeps,
      fullEligibleStates: full.states,
      fullEligibleTruncated: full.truncated,
    });
    console.log(
      `${scenarioId}: phase2=${baseline.states} sweeps=${sweeps.map((entry) => `${entry.states}${entry.truncated ? "+" : ""}`).join("/")} full=${full.states}${full.truncated ? "+" : ""}`,
    );
  }
  await writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        kind: "phase2-successor-closure",
        options: { maxStates, scenarioIds, tolerance: 0 },
        records,
        version: 1,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Wrote ${OUTPUT_FILE.pathname}`);
} finally {
  await server.close();
}
