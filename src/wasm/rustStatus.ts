export const RUST_STATUS_OK = 0;
export const RUST_STATUS_BUDGET_EXCEEDED = 1;
export const RUST_STATUS_MEMO_FULL = 2;
const RUST_STATUS_INVALID_INPUT = 3;

export type RustStatusExports = {
  getSolveStatus?: () => number;
};

export type RustSolveErrorReason = "status" | "missing_export" | "stale_handle";

function rustStatusName(status: number) {
  if (status === RUST_STATUS_OK) return "ok";
  if (status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  if (status === RUST_STATUS_MEMO_FULL) return "memo_full";
  if (status === RUST_STATUS_INVALID_INPUT) return "invalid_input";
  return `unknown_${status}`;
}

export class RustSolveError extends Error {
  readonly nodeCount: number | null;
  readonly reason: RustSolveErrorReason;
  readonly status: number | null;

  constructor(operation: string, status: number, reason?: "status", nodeCount?: number | null);
  constructor(
    operation: string,
    status: null,
    reason: "missing_export" | "stale_handle",
    nodeCount?: number | null,
  );
  constructor(
    operation: string,
    status: number | null,
    reason: RustSolveErrorReason = "status",
    nodeCount: number | null = null,
  ) {
    super(errorMessage(operation, status, reason));
    this.name = "RustSolveError";
    this.nodeCount = nodeCount;
    this.reason = reason;
    this.status = status;
  }
}

export function isMemoFull(error: unknown): error is RustSolveError {
  return (
    error instanceof RustSolveError &&
    error.reason === "status" &&
    error.status === RUST_STATUS_MEMO_FULL
  );
}

export function assertRustStatusOk(exports: RustStatusExports, operation: string) {
  const status = exports.getSolveStatus?.() ?? RUST_STATUS_OK;
  if (status === RUST_STATUS_OK) return;
  throw new RustSolveError(operation, status);
}

function errorMessage(operation: string, status: number | null, reason: RustSolveErrorReason) {
  if (reason === "missing_export") return `Rust solver export ${operation} is missing.`;
  if (reason === "stale_handle")
    return `Rust solver ${operation} handle is stale because a newer policy was built.`;
  return `Rust solver ${operation} failed with status ${rustStatusName(status ?? -1)}.`;
}
