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

export type ResultView =
  | { type: "empty"; message: string }
  | { type: "callout"; message: string }
  | { type: "error"; message: string }
  | { type: "recommendation"; kit: Kit; count: number; multiUse: boolean }
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
    };

export type ValidationView = {
  buttonLabel: string;
  disabled: boolean;
  message: string;
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
  kit?: Kit;
  events?: number;
  attempts?: number;
  greatSuccesses?: number;
  greatSuccessRate?: number;
  theoreticalGreatSuccessRate?: number;
};

export type SegmentStat = {
  key: string;
  label: string;
  events?: number;
  attempts?: number;
  greatSuccesses?: number;
  greatSuccessRate?: number;
  theoreticalGreatSuccessRate?: number;
  theoreticalRate?: number;
};

export type LevelKitStat = {
  grade: Grade;
  level: number;
  kits: Record<Kit, KitStat>;
};

export type GlobalStats = {
  summary?: {
    events?: number;
    attempts?: number;
    greatSuccesses?: number;
    greatSuccessRate?: number;
    todayEvents?: number;
    todayAttempts?: number;
    todayGreatSuccesses?: number;
    mostUsedKit?: Kit | null;
    mostUsedKitPieces?: number;
  };
  byKit?: KitStat[];
  levelKitStats?: LevelKitStat[];
  segmentStats?: SegmentStat[];
};

export type StatsView =
  | { type: "hidden" }
  | { type: "empty"; message: string }
  | { type: "stats"; stats: GlobalStats };

export type CalculatorInput = {
  start: CollectionState;
  stock: Stock;
  strategy: Strategy;
};
