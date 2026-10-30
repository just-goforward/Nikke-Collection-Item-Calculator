import type { SolverInput } from "../types";
import type { SolverResult } from "../hooks/calculatorShared";

/** Internal observer API, not a wire event or a second calculator state. */
export type DecisionLifecycle = {
  begin: (input: SolverInput) => unknown;
  accepted: (owner: unknown, input: SolverInput, result: SolverResult, origin: "final") => void;
  captureOutcomeOwner: () => unknown;
  outcomeConfirmed: (owner: unknown, outcome: "success" | "fail") => void;
  retire: (owner: unknown, reason: "input_edit" | "restore" | "forecast_invalid" | "unmount" | "reset" | "superseded" | "cancelled") => void;
  attemptReported: (owner: unknown, attempt: number) => void;
  presented?: (owner: unknown, leaf: "current" | "wait" | "conversion" | "callout") => void;
  explicitAction?: (owner: unknown, action: "input_edit" | "recalculate" | "reset" | "outcome_open" | "dismiss") => void;
};

/** Only observer failures are isolated; calculator failures retain their original behavior. */
export function observeDecision<T>(callback: (() => T) | undefined): T | undefined {
  try { return callback?.(); } catch { return undefined; }
}
