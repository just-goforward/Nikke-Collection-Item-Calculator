import type { SolverInput } from "../types";
import type { SolverResult } from "../hooks/calculatorShared";
import type { AcceptedOutcomeContext } from "./acceptedOutcome";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";

/** Internal observer API, not a wire event or a second calculator state. */
export type DecisionLifecycle = {
  begin: (input: SolverInput) => unknown;
  accepted: (owner: unknown, input: SolverInput, result: SolverResult, origin: "final" | "current_checkpoint") => void;
  captureOutcomeOwner: () => unknown;
  prepareOutcome?: (owner: unknown, context: AcceptedOutcomeContext) => unknown;
  releaseOutcomePreparation?: (prepared: unknown) => void;
  outcomeConfirmed: (owner: unknown, outcome: "success" | "fail", prepared?: unknown, legacySettlement?: StatsSubmissionEvent) => void;
  retire: (owner: unknown, reason: "input_edit" | "restore" | "forecast_invalid" | "unmount" | "reset" | "superseded" | "cancelled") => void;
  attemptReported: (owner: unknown, attempt: number, legacySettlement?: StatsSubmissionEvent) => void;
  retainLegacySettlement?: (owner: unknown, event: StatsSubmissionEvent) => void;
  presented?: (owner: unknown, leaf: "current" | "wait" | "conversion" | "callout") => void;
  explicitAction?: (owner: unknown, action: "input_edit" | "recalculate" | "reset" | "outcome_open" | "dismiss") => void;
};

/** Only observer failures are isolated; calculator failures retain their original behavior. */
export function observeDecision<T>(callback: (() => T) | undefined): T | undefined {
  try { return callback?.(); } catch { return undefined; }
}
