import { type RefObject, useCallback, useRef, useState } from "react";

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

type UseOutcomeFlowOptions = {
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
  const applyOutcome = useOutcomeApplication({
    ...options,
    applyKnownSuccessAttempt,
    renderOutcomeApplied,
    setModal,
    terminalSuccessContextRef,
  });
  const applyConvert = useConvertAction(options);

  const submitSuccessAttempt = useCallback(
    (successAttempt: number | null) => {
      const context = terminalSuccessContextRef.current;
      terminalSuccessContextRef.current = null;
      setModal((current) => ({ ...current, open: false }));
      if (!context) return;
      applyTerminalSuccessAttempt(context, successAttempt);
    },
    [applyTerminalSuccessAttempt],
  );

  const resetOutcomeFlow = useCallback(() => {
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
