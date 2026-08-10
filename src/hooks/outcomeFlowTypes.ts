import type { Dispatch, RefObject, SetStateAction } from "react";
import type { LocalizedMessage } from "../i18n/messages.ko";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import type { CollectionState, SolverInput, Stock } from "../types";
import type {
  DetailView,
  RecommendationAction,
  ResultView,
  StateChangeFeedback,
  SuccessAttemptModalState,
  ValidationView,
} from "../ui-types";
import type {
  PendingStatsEvent,
  RecommendedRun,
  SolverBest,
  SolverResult,
  TerminalSuccessContext,
} from "./calculatorShared";

export type OutcomeRenderArgs = {
  best: SolverBest;
  run: RecommendedRun;
  nextState: CollectionState;
  outcome: "success" | "fail";
  stockMessage: LocalizedMessage;
  detailMessage: LocalizedMessage;
  preserveExistingResult?: boolean;
};

export type OutcomeSharedOptions = {
  currentStockSnapshot: () => Stock;
  latestResultRef: RefObject<SolverResult | null>;
  pendingStatsEventRef: RefObject<PendingStatsEvent | null>;
  setPendingStatsEvent: (event: PendingStatsEvent | null) => void;
  queueStatsEvent: (event: StatsSubmissionEvent) => void;
  recordStateFeedback: (from: StateChangeFeedback["from"], to: StateChangeFeedback["to"]) => void;
  setCollectionState: (
    next: CollectionState,
    options?: { maxLevelRender?: boolean; markChanged?: boolean },
  ) => void;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setManualStockEditRequired: (required: boolean) => void;
  setModal: Dispatch<SetStateAction<SuccessAttemptModalState>>;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  setStockCountForKit: (kit: SolverBest["firstAction"], value: number) => void;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
  terminalSuccessContextRef: RefObject<TerminalSuccessContext | null>;
};

export type OutcomeApplyResult =
  | {
      outcome: "fail";
      nextInput: SolverInput;
      needsStockEdit: false;
      previousAction: RecommendationAction;
    }
  | {
      outcome: "success";
      needsStockEdit: true;
      autoCalculation?: never;
    }
  | {
      outcome: "success";
      needsStockEdit: false;
      autoCalculation?: {
        nextInput: SolverInput;
        previousAction: RecommendationAction;
      };
    }
  | null;

export type ConvertApplyResult =
  | { needsStockEdit: true }
  | { needsStockEdit: false; nextInput: SolverInput };
