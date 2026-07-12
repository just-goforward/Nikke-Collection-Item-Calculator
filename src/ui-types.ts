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
  label: string;
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
  | { type: "empty"; message: string }
  | { type: "callout"; reason: "final_target" | "converted"; message: string }
  | { type: "error"; reason: "no_action" | "solver_failure"; message: string }
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
      stockMessage: string;
      canConvert: boolean;
    }
  | {
      type: "convertRecommendation";
      reason: "r15_conversion";
      autoCalculateAfterConvert?: boolean;
    };

export type CandidateView = {
  rankLabel: string;
  kit: Kit;
  count: number;
  successProbability: string;
  successProbabilityMedium: string;
  successProbabilityDetailed: string;
  expectedKits?: string;
  expectedBreakdown?: string;
  excludedReason?: string | null;
  excludedReasonHelp?: string | null;
};

export type ValidationStageReachPointView = {
  label: string;
  probability: number;
  percentLabel: string;
  reachedLabel: string;
  aggregateBelow?: boolean;
  aggregateAbove?: boolean;
};

export type ValidationStageReachView = {
  runsLabel: string;
  points: ValidationStageReachPointView[];
};

export type DetailView =
  | { type: "empty"; message: string }
  | {
      type: "metrics";
      successProbability: string;
      greatSuccessProbability: string;
      candidates: CandidateView[];
      monteCarloRuns: string;
      solverLabel: string;
    };

export type ValidationView = {
  buttonLabel: string;
  disabled: boolean;
  message: string;
  status: "idle" | "running" | "complete" | "cancelled" | "error";
  stageReach?: ValidationStageReachView | null;
};

export type LoadingView = {
  active: boolean;
  text: string;
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
  | { type: "empty"; message: string }
  | { type: "error"; message: string }
  | { type: "stats"; stats: StatsPanelModel };
