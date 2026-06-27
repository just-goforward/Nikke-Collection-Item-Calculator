import type { CollectionState, Grade, Kit, Stock, Strategy } from "./types";

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

export type ResultView =
  | { type: "empty"; message: string }
  | { type: "callout"; message: string }
  | { type: "error"; message: string }
  | {
      type: "recommendation";
      kit: Kit;
      count: number;
      actionTransition?: RecommendationActionTransition;
    }
  | {
      type: "outcome";
      kit: Kit;
      count: number;
      outcomeLabel: string;
      stateText: string;
      stockMessage: string;
      showConvertRecommendation: boolean;
    }
  | { type: "convertRecommendation" };

export type CandidateView = {
  rankLabel: string;
  kit: Kit;
  count: number;
  successProbability: string;
  expectedKits?: string;
  expectedBreakdown?: string;
  excludedReason?: string | null;
};

export type ExpectedConsumptionView = {
  kit: Kit;
  pieces: string;
  supplyDays: string;
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
      strategyLabel: string;
      successProbability: string;
      greatSuccessProbability: string;
      stateCount: string;
      candidates: CandidateView[];
      monteCarloRuns: string;
      expectedConsumption: ExpectedConsumptionView[];
      expectedRemaining: string;
      solverLabel: string;
    };

export type ValidationView = {
  buttonLabel: string;
  disabled: boolean;
  message: string;
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
};

export type KitStat = {
  kit?: Kit | undefined;
  events?: number | undefined;
  attempts?: number | undefined;
  pieces?: number | undefined;
  greatSuccesses?: number | undefined;
  greatSuccessRate?: number | undefined;
  theoreticalGreatSuccessRate?: number | undefined;
};

export type SegmentStat = {
  key: string;
  label: string;
  events?: number | undefined;
  attempts?: number | undefined;
  pieces?: number | undefined;
  greatSuccesses?: number | undefined;
  greatSuccessRate?: number | undefined;
  theoreticalGreatSuccessRate?: number | undefined;
  theoreticalRate?: number | undefined;
  byKit?: KitStat[] | undefined;
};

export type LevelKitStat = {
  grade: Grade;
  level: number;
  kits: Record<Kit, KitStat>;
};

export type GlobalStats = {
  windowDays?: number | undefined;
  summary?: {
    events?: number | undefined;
    attempts?: number | undefined;
    greatSuccesses?: number | undefined;
    greatSuccessRate?: number | undefined;
    todayEvents?: number | undefined;
    todayAttempts?: number | undefined;
    todayGreatSuccesses?: number | undefined;
    mostUsedKit?: Kit | null | undefined;
    mostUsedKitPieces?: number | undefined;
  };
  byKit?: KitStat[] | undefined;
  cumulative?:
    | {
        summary?: {
          events?: number | undefined;
          attempts?: number | undefined;
          greatSuccesses?: number | undefined;
          greatSuccessRate?: number | undefined;
          mostUsedKit?: Kit | null | undefined;
          mostUsedKitPieces?: number | undefined;
        };
        byKit?: KitStat[] | undefined;
      }
    | undefined;
  levelKitStats?: LevelKitStat[] | undefined;
  segmentStats?: SegmentStat[] | undefined;
};

export type StatsView =
  | { type: "hidden" }
  | { type: "empty"; message: string }
  | { type: "error"; message: string }
  | { type: "stats"; stats: GlobalStats };

export type CalculatorInput = {
  start: CollectionState;
  stock: Stock;
  strategy: Strategy;
};
