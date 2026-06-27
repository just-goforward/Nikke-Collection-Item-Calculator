export type Grade = "R" | "SR";
export type Kit = "blue" | "purple" | "yellow";
export type Strategy = "single" | "supply";
export type WorkerTaskType = "solve" | "validate";

export interface CollectionState {
  grade: Grade;
  level: number;
  exp: number;
}

export type KitRecord<T> = Record<Kit, T>;

export interface Stock extends KitRecord<number> {}

export interface SolverInput {
  start: CollectionState;
  stock: Stock;
  strategy?: Strategy;
  monteCarloRuns?: number;
  monteCarloSeed?: number;
}

export interface TransitionResult {
  probability: number;
  success: CollectionState;
  fail: CollectionState;
}

export interface StageReachPoint {
  grade: Grade;
  level: number;
  reached: number;
  probability: number;
}

export interface MonteCarloResult {
  runs: number;
  completed: number;
  successProbability: number;
  vector: Stock;
  quantiles?: KitRecord<{ p50: number; p90: number; p95: number }>;
  depletion?: number;
  stageReach?: StageReachPoint[];
}

export interface SolverResult {
  recommendation: Record<string, unknown> | null;
  route: Array<Record<string, unknown>>;
  monteCarlo: MonteCarloResult | null;
  stats: Record<string, unknown>;
  topCandidates: Array<Record<string, unknown>>;
}

export interface StatsEndpointConfig {
  endpoint?: string;
  turnstileSiteKey?: string;
}

export interface StatsConfig extends StatsEndpointConfig {
  staging?: StatsEndpointConfig;
}

export interface ProgressEvent {
  phase: string;
  scanned?: number;
  total?: number | null;
}

export type WorkerRequest =
  | { type: "solve"; id: number; input: SolverInput; backend?: string; wasmUrl?: string }
  | {
      type: "validate";
      id: number;
      input: SolverInput;
      runs?: number;
      seed?: number;
      backend?: string;
      wasmUrl?: string;
    };

export type WorkerResponse =
  | { type: "progress"; id: number; progress: ProgressEvent }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; message: string };
