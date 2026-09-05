export type DebtEntry = {
  file: string;
  reason: string;
  owner: "app" | "worker" | "solver" | "wasm" | "benchmark" | "test" | "architecture";
  removalTarget: string;
};

export type FunctionDebtEntry = DebtEntry & {
  function: string;
};

export type ModuleBoundaryDebtEntry = DebtEntry & {
  dependency: string;
};

export type ArchitectureIssue = {
  code:
    | "cycle"
    | "boundary-violation"
    | "empty-catch"
    | "function-complexity"
    | "function-depth"
    | "function-lines"
    | "missing-allowlist-entry"
    | "oversized-file"
    | "re-export"
    | "text-alignment"
    | "unreachable-source"
    | "unsafe-type-escape"
    | `unapproved-${"biome"}-ignore`;
  message: string;
  file?: string;
};

export type FunctionMetrics = {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  lines: number;
  maxDepth: number;
  complexity: number;
};

export type RuleLimits = {
  maxFunctionLines: number;
  maxDepth: number;
  maxComplexity: number;
};
