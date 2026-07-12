import type {
  CollectionState as SharedCollectionState,
  Grade as SharedGrade,
  Kit as SharedKit,
  SolverInput as SharedSolverInput,
  Stock as SharedStock,
  Strategy as SharedStrategy,
} from "../shared/game";
import type { ProgressEvent as SharedProgressEvent } from "../shared/workerProtocol";

export type Grade = SharedGrade;
export type Kit = SharedKit;
export type Strategy = SharedStrategy;

export type CollectionState = SharedCollectionState;

export type Stock = SharedStock;

export type SolverInput = SharedSolverInput;

export interface StageReachPoint {
  grade: Grade;
  level: number;
  reached: number;
  probability: number;
}

export interface StatsEndpointConfig {
  endpoint?: string;
  turnstileSiteKey?: string;
}

export interface StatsConfig extends StatsEndpointConfig {
  staging?: StatsEndpointConfig;
}

export type ProgressEvent = SharedProgressEvent;
