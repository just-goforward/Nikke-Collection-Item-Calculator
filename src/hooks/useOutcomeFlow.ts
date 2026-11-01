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
import { interceptOutcomeSettlement, isOutcomeReportSettlementActive, markOutcomeReportPending, withOutcomeReportSettlement } from "../analytics/acceptedOutcome";

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
  const attemptLifecycles = useRef(new WeakMap<TerminalSuccessContext, DecisionLifecycle>());
  const reportContexts = useRef(new WeakSet<TerminalSuccessContext>());
  const queueStatsEvent = useCallback((event: StatsSubmissionEvent) => {
    if (!interceptOutcomeSettlement(event)) options.queueStatsEvent(event);
  }, [options.queueStatsEvent]);
  const setPendingStatsEvent = useCallback((event: PendingStatsEvent | null) => {
    if (event && isOutcomeReportSettlementActive()) markOutcomeReportPending(event);
    options.setPendingStatsEvent(event);
  }, [options.setPendingStatsEvent]);
  const renderOutcomeApplied = useOutcomeRenderer(options);
  const applyTerminalSuccessAttempt = useTerminalSuccessAttempt({
    ...options,
    queueStatsEvent,
    setPendingStatsEvent,
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
    queueStatsEvent,
    setPendingStatsEvent,
    applyKnownSuccessAttempt,
    renderOutcomeApplied,
    setModal,
    terminalSuccessContextRef,
  });
  const applyOutcome = useCallback((outcome: "success" | "fail") => {
    const owner = options.observerOwner;
    const applied = applyInnerOutcome(outcome);
    const context = terminalSuccessContextRef.current;
    if (applied && context && owner !== undefined) {
      attemptOwners.current.set(context, owner);
      if (options.lifecycle) attemptLifecycles.current.set(context, options.lifecycle);
      if (isOutcomeReportSettlementActive()) reportContexts.current.add(context);
    }
    return applied;
  }, [applyInnerOutcome, options.observerOwner, options.lifecycle]);
  const applyConvert = useConvertAction(options);

  const submitSuccessAttempt = useCallback(
    (successAttempt: number | null) => {
      const context = terminalSuccessContextRef.current;
      terminalSuccessContextRef.current = null;
      setModal((current) => ({ ...current, open: false }));
      if (!context) return;
      let legacySettlement: StatsSubmissionEvent | undefined;
      const settled = withOutcomeReportSettlement(reportContexts.current.has(context),
        () => applyTerminalSuccessAttempt(context, successAttempt), event => { legacySettlement = event; });
      const owner = attemptOwners.current.get(context);
      const lifecycle = attemptLifecycles.current.get(context);
      attemptOwners.current.delete(context);
      attemptLifecycles.current.delete(context);
      reportContexts.current.delete(context);
      if (settled && successAttempt !== null && owner !== undefined)
        observeDecision(lifecycle ? () => lifecycle.attemptReported(owner, successAttempt, legacySettlement) : undefined);
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
