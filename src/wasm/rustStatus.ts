export const RUST_STATUS_OK = 0;
export const RUST_STATUS_BUDGET_EXCEEDED = 1;
export const RUST_STATUS_MEMO_FULL = 2;

export type RustStatusExports = {
  getSolveStatus?: () => number;
};

export function rustStatusName(status: number) {
  if (status === RUST_STATUS_OK) return "ok";
  if (status === RUST_STATUS_BUDGET_EXCEEDED) return "budget_exceeded";
  if (status === RUST_STATUS_MEMO_FULL) return "memo_full";
  return `unknown_${status}`;
}

export class RustSolveError extends Error {
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`Rust solver ${operation} failed with status ${rustStatusName(status)}.`);
    this.name = "RustSolveError";
    this.status = status;
  }
}

export function isMemoFull(error: unknown): boolean {
  return error instanceof RustSolveError && error.status === RUST_STATUS_MEMO_FULL;
}

export function assertRustStatusOk(exports: RustStatusExports, operation: string) {
  const status = exports.getSolveStatus?.() ?? RUST_STATUS_OK;
  if (status === RUST_STATUS_OK) return;
  throw new RustSolveError(operation, status);
}
