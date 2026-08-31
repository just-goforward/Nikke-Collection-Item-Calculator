/// <reference path="../worker-configuration.d.ts" />

export type DispatcherEnvironment = "staging" | "production";

export type DispatcherEnv = Omit<GeneratedForecastDispatcherEnv, "ENVIRONMENT"> & {
  ENVIRONMENT: DispatcherEnvironment;
  DISPATCH_ENABLED: "true" | "false";
};

export type WorkLink = {
  source: "naver-board-48" | "naver-board-56";
  itemId: string;
  title: string;
  url: string;
};

export type ActionableWork = {
  pendingIds: string[];
  candidateIds: string[];
  links: WorkLink[];
  pendingCount: number;
  candidateCount: number;
  fingerprint: string;
};

export type DispatchReservation = {
  dispatchId: string;
  mode: "work" | "smoke";
  fingerprint: string;
  pendingCount: number;
  candidateCount: number;
  attempt: number;
  links: WorkLink[];
};

export type OpsAlertRow = {
  alertKey: string;
  environment: DispatcherEnvironment;
  severity: "warning" | "critical";
  component: string;
  errorCode: string;
  state: "open" | "resolved";
  context: Record<string, string | number | boolean | null>;
  occurrenceCount: number;
  lastSentOccurrenceCount: number;
};
