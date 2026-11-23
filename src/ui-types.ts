import type { LocalizedMessage } from "./i18n/messages.ko";
import type { CollectionState, Grade, Kit } from "./types";

export type ThemeMode = "system" | "light" | "dark";
export type ResultKit = Kit | "convert";

export type StatePanelModel = {
  grade: Grade;
  level: number;
  exp: number;
  requiredExp: number;
  expDisabled: boolean;
};

export type StateChangeFeedback = {
  id: number;
  type: "level" | "segment" | "grade";
  from: CollectionState;
  to: CollectionState;
};

export type RecommendationAction = {
  kit: ResultKit;
  count: number;
};

export type RecommendationActionTransition = {
  id: number;
  previous: RecommendationAction;
};

export type OutcomePreview = {
  state: CollectionState;
  movement: "reach" | "stay";
  expDelta: number;
};

export type ResultView =
  | { type: "empty"; message: LocalizedMessage }
  | { type: "loading"; previousAction?: RecommendationAction; previousFinalDetail?: DetailView }
  | { type: "callout"; reason: "final_target" | "converted" | "certified_preserve" | "adaptive_no_first_kit"; message: LocalizedMessage }
  | {
      type: "error";
      recalculationFailure?: true;
      reason:
        | "no_action"
        | "solver_failure"
        | "solver_capacity_failure"
        | "follow_up_outcome_failure"
        | "follow_up_conversion_failure"
        | "certified_preserve"
        | "certified_claim_required";
      message: LocalizedMessage;
    }
  | {
      type: "recommendation";
      kit: Kit;
      count: number;
      practicalAction?: true;
      conditionalAction?: true;
      stockOnlyAction?: true;
      batchAction?: true;
      failPreview: OutcomePreview;
      successPreview: OutcomePreview;
      actionTransition?: RecommendationActionTransition;
    }
  | {
      type: "outcome";
      kit: Kit;
      count: number;
      outcome: "success" | "fail";
      state: CollectionState;
      stockMessage: LocalizedMessage;
      canConvert: boolean;
    }
  | {
      type: "convertRecommendation";
      reason: "r15_conversion";
      actionTransition?: RecommendationActionTransition;
    };

export type CandidateView = {
  rankLabel: LocalizedMessage;
  kit: Kit;
  count: number;
  successProbability: string;
  successProbabilityMedium: string;
  successProbabilityDetailed: string;
  expectedKits?: LocalizedMessage;
  expectedBreakdown?: LocalizedMessage;
  excludedReason?: LocalizedMessage | null;
  excludedReasonHelp?: LocalizedMessage | null;
};

export type ValidationStageReachPointView = {
  stateLabel: string;
  probability: number;
  reached: number;
  aggregateBelow?: boolean;
  aggregateAbove?: boolean;
};

export type ValidationStageReachView = {
  runs: number;
  points: ValidationStageReachPointView[];
};

export type PreviewEvidence = {
  conditional?:true;
  legacyD0?: true;
  action: { kit: Kit; count: number; tied: Kit[]; probability: string; pieces: number } | null;
  lastDay: number | null;
  prefixMetrics?: { day: number; probability: [number, number]; pieces: [number, number] }[];
  prefixComparison?: true;
  complete: boolean;
  comparison?: "unavailable" | "bounded";
  withheld: boolean;
  source: string;
  reason: string | null;
};

type ExpectedPieces = readonly [number, number, number];
export type PreviewTimedSupply = {
  asOf: string;
  conditional: boolean;
  arrivals: readonly { at: string; pieces: ExpectedPieces; cumulative: ExpectedPieces }[];
};

export type DetailView = { previewTimedSupply?: PreviewTimedSupply | null; previewEvidence?: PreviewEvidence } & (
  | { type: "empty"; message: LocalizedMessage; waitingLabel?: LocalizedMessage }
  | { type: "loading" }
  | {
      type: "metrics";
      successProbability: string;
      greatSuccessProbability: string | null;
      /** Final validated stable WAIT only; never populated by a Current checkpoint. */
      recommendedWaitDays?: number;
      recommendedWaitAt?: string;
      waitingLabel?: LocalizedMessage;
      focusRequestedSummary?: true;
      candidates: CandidateView[];
      monteCarloRuns: number;
      solverLabel: string;
    });

export type ValidationView = {
  buttonLabel: LocalizedMessage;
  disabled: boolean;
  message: LocalizedMessage;
  status: "idle" | "running" | "complete" | "cancelled" | "error";
  stageReach?: ValidationStageReachView | null;
};

export type LoadingView = {
  active: boolean;
  text: LocalizedMessage;
};

export type StockCorrectionInvalidReason =
  | "unchanged"
  | "state_changed"
  | "other_kit_changed"
  | "selected_kit_increased"
  | "invalid_delta"
  | "too_many_attempts";

export type StockCorrectionView = {
  allowedMaximum: number;
  allowedMinimum: number;
  beforeStock: number;
  canCalculate: boolean;
  currentStock: number;
  kit: Kit;
  recommendedUses: number;
  status: "invalid" | "valid";
  reason?: StockCorrectionInvalidReason;
  successAttempt?: number;
};

export type SuccessAttemptModalState = {
  open: boolean;
  maxAttempt: number;
  attempt: number;
  kit?: Kit;
  beforeStock?: number;
};

export type KitStat = {
  kit: Kit;
  events: number;
  attempts: number;
  pieces: number;
  greatSuccesses: number;
  greatSuccessRate: number;
  theoreticalGreatSuccessRate: number;
};

export type SegmentStat = {
  key: string;
  label: string;
  events: number;
  attempts: number;
  pieces: number;
  greatSuccesses: number;
  greatSuccessRate: number;
  theoreticalGreatSuccessRate: number;
  averageAttempts: number;
  byKit: KitStat[];
};

export type LevelKitStat = {
  grade: Grade;
  level: number;
  kits: Record<Kit, KitStat>;
};

export type StatsSummary = {
  events: number;
  attempts: number;
  greatSuccesses: number;
  greatSuccessRate: number;
  todayEvents: number;
  todayAttempts: number;
  todayGreatSuccesses: number;
  mostUsedKit: Kit | null;
  mostUsedKitPieces: number;
};

export type StatsPanelModel = {
  windowDays: number;
  summary: StatsSummary;
  byKit: KitStat[];
  cumulative: {
    summary: StatsSummary;
    byKit: KitStat[];
  };
  levelKitStats: LevelKitStat[];
  segmentStats: SegmentStat[];
};

export type StatsView =
  | { type: "hidden" }
  | { type: "loading"; message: LocalizedMessage }
  | { type: "unconfigured"; message: LocalizedMessage }
  | { type: "empty"; message: LocalizedMessage }
  | { type: "error"; message: LocalizedMessage }
  | { type: "stats"; stats: StatsPanelModel };
