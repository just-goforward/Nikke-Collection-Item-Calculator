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
  kit: Kit;
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
  | { type: "callout"; reason: "final_target" | "converted"; message: LocalizedMessage }
  | { type: "error"; reason: "no_action" | "solver_failure"; message: LocalizedMessage }
  | {
      type: "recommendation";
      kit: Kit;
      count: number;
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

export type DetailView =
  | { type: "empty"; message: LocalizedMessage }
  | {
      type: "metrics";
      successProbability: string;
      greatSuccessProbability: string;
      candidates: CandidateView[];
      monteCarloRuns: number;
      solverLabel: string;
    };

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

export type StockCorrectionView = {
  allowedMaximum: number;
  allowedMinimum: number;
  beforeStock: number;
  canCalculate: boolean;
  currentStock: number;
  kit: Kit;
  recommendedUses: number;
  status: "invalid" | "valid";
  reason?:
    | "unchanged"
    | "state_changed"
    | "other_kit_changed"
    | "selected_kit_increased"
    | "invalid_delta"
    | "too_many_attempts";
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
