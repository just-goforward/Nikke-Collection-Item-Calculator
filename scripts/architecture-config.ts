import type { DebtEntry, RuleLimits } from "./architecture-types.ts";

export const CHECK_ROOTS = [
  "src",
  "cloudflare/src",
  "benchmarks",
  "scripts",
  "e2e",
  "rust/solver-rs/src",
];

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".rs"];
export const DEFAULT_MAX_FILE_LINES = 900;
const BIOME_IGNORE_TOKEN = `biome${"-ignore"}`;

export const LONG_FILE_ALLOWLIST: DebtEntry[] = [];

export const TYPE_ESCAPE_BOUNDARY_ALLOWLIST: DebtEntry[] = [
  {
    file: "cloudflare/src/worker.test.ts",
    owner: "test",
    reason: "Miniflare and Worker test harness need platform boundary casts.",
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

export const COMPLEXITY_ALLOWLIST: DebtEntry[] = [
  ...LONG_FILE_ALLOWLIST,
  {
    file: "scripts/architecture-rules.ts",
    owner: "architecture",
    reason: "Architecture scanner currently uses regex/string parsing and is tested by fixtures.",
    removalTarget: "Replace function metric scanning with a TypeScript AST parser.",
  },
  {
    file: "benchmarks/analyze-availability.ts",
    owner: "benchmark",
    reason: "Availability analyzer still combines parsing, aggregation, and console reporting.",
    removalTarget: "Split data loading, Pareto aggregation, and report formatting.",
  },
  {
    file: "benchmarks/run-availability-select.ts",
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
