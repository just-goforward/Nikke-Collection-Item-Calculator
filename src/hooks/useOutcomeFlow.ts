import { type RefObject, useCallback, useRef, useState } from "react";
import { setVolatileOutcomeRecovery as setLegacyOutcomeRecovery } from "../lib/volatileSession";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import type { CollectionState, Kit, Stock } from "../types";
import type {
  DetailView,
  ResultView,
  StateChangeFeedback,
  SuccessAttemptModalState,
  ValidationView,
} from "../ui-types";
import type { PendingStatsEvent, SolverResult, TerminalSuccessContext } from "./calculatorShared";
import { useOutcomeApplication } from "./outcomeApplication";
import { useConvertAction } from "./outcomeConvertAction";
import { useOutcomeRenderer } from "./outcomeRenderer";
import { useTerminalSuccessAttempt } from "./terminalSuccessAttempt";
import { observeDecision, type DecisionLifecycle } from "../analytics/decisionLifecycle";

type UseOutcomeFlowOptions = {
  lifecycle?: DecisionLifecycle;
  observerOwner?: unknown;
  latestResultRef: RefObject<SolverResult | null>;
  pendingStatsEventRef: RefObject<PendingStatsEvent | null>;
  setPendingStatsEvent: (event: PendingStatsEvent | null) => void;
  currentStockSnapshot: () => Stock;
  setCollectionState: (
    next: CollectionState,
    options?: { maxLevelRender?: boolean; markChanged?: boolean },
  ) => void;
  setStockCountForKit: (kit: Kit, value: number) => void;
  setManualStockEditRequired: (required: boolean) => void;
  setResultView: React.Dispatch<React.SetStateAction<ResultView>>;
  setDetailView: React.Dispatch<React.SetStateAction<DetailView>>;
  setValidationView: React.Dispatch<React.SetStateAction<ValidationView>>;
  queueStatsEvent: (event: StatsSubmissionEvent) => void;
  currentStateSnapshot: () => CollectionState;
  recordStateFeedback: (from: StateChangeFeedback["from"], to: StateChangeFeedback["to"]) => void;
};

export function useOutcomeFlow(options: UseOutcomeFlowOptions) {
  const [modal, setModal] = useState<SuccessAttemptModalState>({
    open: false,
    maxAttempt: 1,
    attempt: 1,
  });
  const terminalSuccessContextRef = useRef<TerminalSuccessContext | null>(null);
  const attemptOwners = useRef(new WeakMap<TerminalSuccessContext, unknown>());
  const renderOutcomeApplied = useOutcomeRenderer(options);
  const applyTerminalSuccessAttempt = useTerminalSuccessAttempt({
    ...options,
    renderOutcomeApplied,
  });
  const applyKnownSuccessAttempt = useCallback(
    (context: TerminalSuccessContext, successAttempt: number) => {
      const calculation = applyTerminalSuccessAttempt(context, successAttempt, {
        renderIntermediate: false,
      });
      if (!calculation) {
        throw new Error("Known success attempt did not produce the next solver input.");
      }
      return calculation;
    },
    [applyTerminalSuccessAttempt],
  );
  const applyInnerOutcome = useOutcomeApplication({
    ...options,
    applyKnownSuccessAttempt,
    renderOutcomeApplied,
    setModal,
    terminalSuccessContextRef,
  });
  const applyOutcome = useCallback((outcome: "success" | "fail") => {
    const owner = options.observerOwner;
    const applied = applyInnerOutcome(outcome);
    const context = terminalSuccessContextRef.current;
    if (applied && context && owner !== undefined) attemptOwners.current.set(context, owner);
    return applied;
  }, [applyInnerOutcome, options.observerOwner]);
  const applyConvert = useConvertAction(options);

  const submitSuccessAttempt = useCallback(
    (successAttempt: number | null) => {
      const context = terminalSuccessContextRef.current;
      terminalSuccessContextRef.current = null;
      setModal((current) => ({ ...current, open: false }));
      if (!context) return;
      const settled = applyTerminalSuccessAttempt(context, successAttempt);
      const owner = attemptOwners.current.get(context);
      attemptOwners.current.delete(context);
      if (successAttempt !== null && owner !== undefined && owner === options.observerOwner)
        observeDecision(options.lifecycle ? () => options.lifecycle!.attemptReported(owner, successAttempt) : undefined);
      if (successAttempt === null && owner !== undefined && owner === options.observerOwner)
        observeDecision(options.lifecycle ? () => options.lifecycle!.retire(owner, "cancelled") : undefined);
      setLegacyOutcomeRecovery(
        settled ? { ...settled.nextInput.start, stock: settled.nextInput.stock } : null,
      );
    },
    [applyTerminalSuccessAttempt, options.lifecycle, options.observerOwner],
  );

  const resetOutcomeFlow = useCallback(() => {
    setLegacyOutcomeRecovery(null);
    terminalSuccessContextRef.current = null;
    setModal({ open: false, maxAttempt: 1, attempt: 1 });
  }, []);

  return {
    modal,
    applyOutcome,
    applyConvert,
    submitSuccessAttempt,
    resetOutcomeFlow,
  };
}
