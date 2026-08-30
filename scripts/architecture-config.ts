import type { DebtEntry, FunctionDebtEntry, RuleLimits } from "./architecture-types.ts";

export const CHECK_ROOTS = [
  "src",
  "shared",
  "cloudflare/src",
  "forecast-collector/src",
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
  {
    file: "forecast-collector/src/db.test.ts",
    owner: "test",
    reason: "The Miniflare D1 fixture is adapted to the generated Worker binding contract.",
    removalTarget: "Provide a typed forecast-collector Miniflare environment factory.",
  },
  {
    file: "forecast-collector/src/discord-approval.test.ts",
    owner: "test",
    reason: "Discord interaction tests adapt Miniflare bindings and the rate-limit test double.",
    removalTarget: "Share typed collector environment and rate-limit fixture builders.",
  },
  {
    file: "forecast-collector/src/source-queue.test.ts",
    owner: "test",
    reason: "Source queue integration tests adapt a Miniflare environment to generated bindings.",
    removalTarget: "Use the shared typed collector environment fixture.",
  },
  {
    file: "forecast-collector/src/worker.test.ts",
    owner: "test",
    reason: "Worker boundary tests adapt request, execution-context, and rate-limit test doubles.",
    removalTarget: "Introduce typed Worker request and execution-context fixture builders.",
  },
];

export const BIOME_IGNORE_ALLOWLIST: DebtEntry[] = [
  {
    file: "scripts/architecture-rules.ts",
    owner: "architecture",
    reason: `Rule messages intentionally mention ${BIOME_IGNORE_TOKEN} while checking that token elsewhere.`,
    removalTarget:
      "Tokenize rule strings or move rule names to data before removing this exception.",
  },
  {
    file: "src/components/StatePanel.tsx",
    owner: "app",
    reason: "Existing grouped controls rely on div role=group and stable visual/test contract.",
    removalTarget:
      "Replace grouped controls with semantic fieldset/radio UI in a separate UI refactor.",
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
    file: "forecast-collector/src/candidate.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Candidate validation cases share one D1-independent fixture contract.",
    removalTarget: "Split parser, invariant, and payload-hash cases into separate describe blocks.",
  },
  {
    file: "forecast-collector/src/db.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Collector database lifecycle cases share one Miniflare D1 setup.",
    removalTarget: "Extract a reusable D1 fixture and split canary, health, and candidate suites.",
  },
  {
    file: "forecast-collector/src/db.ts",
    function: "readCanaryReport",
    owner: "worker",
    reason:
      "The canary certificate currently assembles invocation, queue, and integrity counters together.",
    removalTarget: "Extract independent counter queries and a pure canary decision assembler.",
  },
  {
    file: "forecast-collector/src/discord-approval.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason:
      "Discord signature, test approval, and staging adoption cases share one Miniflare D1 fixture.",
    removalTarget:
      "Split interaction security and staging state-transition suites around a shared fixture.",
  },
  {
    file: "forecast-collector/src/naver.test.ts",
    function: "<anonymous>",
    owner: "test",
    reason: "Recorded Naver feed and body parser cases share source fixtures.",
    removalTarget: "Split feed metadata, SmartEditor body, and schedule parsing suites.",
  },
  {
    file: "forecast-collector/src/naver.ts",
    function: "parseNaverFeed",
    owner: "worker",
    reason: "Feed parsing validates several upstream response shapes before normalizing metadata.",
    removalTarget: "Separate upstream schema validation from normalized feed item construction.",
  },
  {
    file: "forecast-collector/src/source-queue.ts",
    function: "pollNaverSource",
    owner: "worker",
    reason: "Cursor recovery and queue insertion remain one transactional polling operation.",
    removalTarget:
      "Extract pagination-state transitions after replay fixtures cover cursor recovery.",
  },
  {
    file: "forecast-collector/src/source-queue.ts",
    function: "processSourceQueue",
    owner: "worker",
    reason:
      "Queue validation and atomic source, event, and candidate writes share one D1 batch boundary.",
    removalTarget: "Extract pure payload validation while keeping the final D1 batch atomic.",
  },
  {
    file: "forecast-collector/src/worker.ts",
    function: "fetch",
    owner: "worker",
    reason:
      "The admin API router keeps authentication and endpoint dispatch in one Worker entrypoint.",
    removalTarget:
      "Move authenticated route groups into typed handlers without duplicating auth checks.",
  },
  {
    file: "benchmarks/evaluator/exact-replan.ts",
    function: "createExactInteractiveReplanSession",
    owner: "benchmark",
    reason:
      "Exact replan session keeps memoized recursion and diagnostics in one benchmark closure.",
    removalTarget:
      "Extract memo storage, recursion, and diagnostic reporting into cohesive helpers.",
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
    removalTarget:
      "Extract shared WASM fixture and split root, walk, and Monte Carlo parity suites.",
  },
  {
    file: "src/wasm/rustRerankProductSolver.ts",
    function: "solveRustPhase2Rerank",
    owner: "wasm",
    reason:
      "Research rerank orchestration combines policy build, held-out diagnostics, and output shaping.",
    removalTarget: "Separate research decision diagnostics from product-shaped result assembly.",
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
