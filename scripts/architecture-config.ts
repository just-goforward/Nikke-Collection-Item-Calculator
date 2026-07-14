import type { DebtEntry, FunctionDebtEntry, RuleLimits } from "./architecture-types.ts";

export const CHECK_ROOTS = [
  "src",
  "shared",
  "cloudflare/src",
  "benchmarks",
  "scripts",
  "e2e",
  "rust/solver-rs/src",
];

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".rs"];
export const DEFAULT_MAX_FILE_LINES = 900;
const BIOME_IGNORE_TOKEN = `biome${"-ignore"}`;

export const LONG_FILE_ALLOWLIST: DebtEntry[] = [
  {
    file: "rust/solver-rs/src/lib.rs",
    owner: "solver",
    reason:
      "The phase2 memo, Bellman recursion, root capture, and exported ABI share one bit-equivalent kernel lifecycle.",
    removalTarget:
      "Split only after instance-owned kernel state can replace the current global memo without changing floating-point order.",
  },
  {
    file: "rust/solver-rs/src/minef.rs",
    owner: "solver",
    reason:
      "The min-E[f] memo table, Bellman recursion, root capture, and WASM ABI form one bit-equivalent kernel boundary.",
    removalTarget:
      "Split only after a module boundary can preserve memo lifetime and floating-point evaluation order without cross-file navigation overhead.",
  },
  {
    file: "e2e/smoke.spec.ts",
    owner: "test",
    reason:
      "The browser smoke suite keeps cross-layout product workflows in one discoverable regression entry.",
    removalTarget:
      "Split a cohesive stats-runtime or outcome-flow suite once it has enough independent setup to avoid duplicating preview lifecycle code.",
  },
];

export const TYPE_ESCAPE_BOUNDARY_ALLOWLIST: DebtEntry[] = [
  {
    file: "cloudflare/src/worker.test.ts",
    owner: "test",
    reason: "The Worker test harness needs Cloudflare runtime boundary casts.",
    removalTarget: "Introduce typed test helpers for env, request, and execution context.",
  },
  {
    file: "src/wasm/rustLoader.ts",
    owner: "wasm",
    reason: "Raw WebAssembly exports enter TypeScript through a single wrapper boundary.",
    removalTarget: "Use per-export runtime validators before constructing RustCoreExports.",
  },
  {
    file: "src/wasm/rustPhase2Parity.test.ts",
    owner: "test",
    reason: "Parity tests instantiate raw WASM exports to compare Rust and JS policies.",
    removalTarget: "Create a typed WASM test loader shared with rustCore tests.",
  },
];

export const BIOME_IGNORE_ALLOWLIST: DebtEntry[] = [
  {
    file: "scripts/architecture-rules.ts",
    owner: "architecture",
    reason: `Rule messages intentionally mention ${BIOME_IGNORE_TOKEN} while checking that token elsewhere.`,
    removalTarget: "Tokenize rule strings or move rule names to data before removing this exception.",
  },
  {
    file: "src/components/StatePanel.tsx",
    owner: "app",
    reason: "Existing grouped controls rely on div role=group and stable visual/test contract.",
    removalTarget: "Replace grouped controls with semantic fieldset/radio UI in a separate UI refactor.",
  },
  {
    file: "src/components/StatsRateBar.tsx",
    owner: "app",
    reason: "Passive pointer tracking is scoped to the difficulty interval visualization.",
    removalTarget: "Move interval tooltip interaction to button/focusable marks.",
  },
  {
    file: "src/components/TopBar.tsx",
    owner: "app",
    reason: "Theme segmented control uses existing grouped control styling and tests.",
    removalTarget: "Replace with semantic radio group in a separate UI refactor.",
  },
];

export const EMPTY_CATCH_ALLOWLIST: DebtEntry[] = [];

export const COMPLEXITY_ALLOWLIST: FunctionDebtEntry[] = [
  {
    file: "benchmarks/evaluator/exact-replan.ts",
    function: "createExactInteractiveReplanSession",
    owner: "benchmark",
    reason: "Exact replan session keeps memoized recursion and diagnostics in one benchmark closure.",
    removalTarget: "Extract memo storage, recursion, and diagnostic reporting into cohesive helpers.",
  },
  {
    file: "benchmarks/models/availability-grid.ts",
    function: "buildAvailabilityGridCandidates",
    owner: "benchmark",
    reason: "Grid generation nests model dimensions and escalation probes.",
    removalTarget: "Represent grid dimensions as data and flatten candidate generation.",
  },
  {
    file: "benchmarks/rust-benchmark-weights.ts",
    function: "parseRustBenchmarkWeightSpec",
    owner: "benchmark",
    reason: "Weight parser validates several optional dimensions and fallback forms.",
    removalTarget: "Parse each weight dimension through a shared schema-driven helper.",
  },
  {
    file: "src/hooks/calculatorDiagnostics.ts",
    function: "makeSolverDiagnosticEvent",
    owner: "app",
    reason: "Diagnostic event construction applies many independent privacy buckets.",
    removalTarget: "Group bucket construction by input, recommendation, and runtime diagnostics.",
  },
  {
    file: "src/hooks/outcomeApplication.ts",
    function: "useOutcomeApplication",
    owner: "app",
    reason: "Outcome application coordinates state, stock, feedback, and statistics side effects.",
    removalTarget: "Extract stock transition and statistics event decisions from React state updates.",
  },
  {
    file: "src/hooks/useCalculatorApp.ts",
    function: "useCalculatorApp",
    owner: "app",
    reason:
      "The root hook composes cohesive calculator state, solver, validation, outcome, and view-model hooks without owning their internal logic.",
    removalTarget:
      "Remove when the app model accepts grouped runtime and view state without adding another navigation-only wrapper.",
  },
  {
    file: "src/solver.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Core solver behavior cases currently share one long describe callback.",
    removalTarget: "Split solver tests by probability, supply cost, and edge-case contracts.",
  },
  {
    file: "src/solver/mdp.ts",
    function: "finiteInventoryMdp",
    owner: "solver",
    reason: "Finite-inventory Bellman recursion keeps transition and tie-break logic together.",
    removalTarget: "Extract transition evaluation without changing memoization semantics.",
  },
  {
    file: "src/solver/mdp.ts",
    function: "value",
    owner: "solver",
    reason: "Bellman recursion keeps gate and candidate comparison in one memoized function.",
    removalTarget: "Extract candidate evaluation without changing floating-point operation order.",
  },
  {
    file: "src/solver/solve.ts",
    function: "solveInternal",
    owner: "solver",
    reason: "Solver result assembly still combines early exits, MDP evaluation, and output shaping.",
    removalTarget: "Separate input terminal handling, candidate evaluation, and result assembly.",
  },
  {
    file: "src/wasm/rustCore.phase2Policy.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Phase2 policy wrapper scenarios share one fixture-heavy describe callback.",
    removalTarget: "Split policy build, stale handle, rollout, and parity test groups.",
  },
  {
    file: "src/wasm/rustPhase2Parity.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Rust/JS parity scenarios share expensive WASM setup and sentinel data.",
    removalTarget: "Extract shared WASM fixture and split root, walk, and Monte Carlo parity suites.",
  },
  {
    file: "src/wasm/rustRerankProductSolver.ts",
    function: "solveRustPhase2Rerank",
    owner: "wasm",
    reason: "Research rerank orchestration combines policy build, held-out diagnostics, and output shaping.",
    removalTarget: "Separate research decision diagnostics from product-shaped result assembly.",
  },
  {
    file: "src/worker.ts",
    function: "<anonymous>",
    owner: "app",
    reason: "Browser worker dispatch coordinates backend selection, fallback, progress, and validation.",
    removalTarget: "Extract backend dispatch and fallback policy into typed command handlers.",
  },
  {
    file: "benchmarks/analyze-availability.ts",
    function: "main",
    owner: "benchmark",
    reason: "Availability analyzer still combines parsing, aggregation, and console reporting.",
    removalTarget: "Split data loading, Pareto aggregation, and report formatting.",
  },
  {
    file: "benchmarks/run-availability-select.ts",
    function: "main",
    owner: "benchmark",
    reason: "Selection runner still combines decision rules, report construction, and file I/O.",
    removalTarget: "Extract selection model, guardrail summaries, and output writers.",
  },
];

export function debtFiles(entries: DebtEntry[]) {
  return new Set(entries.map((entry) => entry.file));
}

export function limitsFor(file: string): RuleLimits {
  if (file.includes(".test.") || file.includes(".spec.") || file.startsWith("benchmarks/")) {
    return { maxFunctionLines: 180, maxDepth: 5, maxComplexity: 25 };
  }
  return { maxFunctionLines: 120, maxDepth: 4, maxComplexity: 15 };
}
