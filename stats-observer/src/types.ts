/// <reference path="../worker-configuration.d.ts" />

export type ObserverEnvironment = "staging" | "production";

export type StatsObserverEnv = Omit<GeneratedStatsObserverEnv, "ENVIRONMENT"> & {
  DISCORD_BOT_TOKEN: string;
  ENVIRONMENT: ObserverEnvironment;
};

export type FailureAggregateRow = {
  recovery_version: number;
  policy_version: string;
  app_revision: string;
  ingest_revision: string;
  forecast_id: string;
  forecast_profile_id: string;
  rust_min_ef_solver_version: string;
  rust_phase2_solver_version: string;
  js_phase2_solver_version: string;
  requested_backend: string;
  min_ef_exit: string;
  phase2_exit: string;
  js_exit: string;
  terminal_backend: string;
  grade: string;
  level: number;
  exp_bucket: number;
  stock_bucket_blue: string;
  stock_bucket_purple: string;
  stock_bucket_yellow: string;
  browser: string;
  browser_major: string;
  os: string;
  os_major: string;
  device_type: string;
  events: number;
  first_seen: number;
  last_seen: number;
};

export type RejectionAggregateRow = {
  rejection_code: string;
  event_kind: string;
  recovery_version: string;
  policy_version: string;
  app_revision: string;
  events: number;
  first_seen: number;
  last_seen: number;
};

export type DeliveryAggregateRow = {
  outcome: string;
  event_kind: string;
  attempts_bucket: string;
  age_bucket: string;
  last_failure_class: string;
  app_revision: string;
  events: number;
  first_seen: number;
  last_seen: number;
};

export type SourceObservation = {
  sourceKind:
    | "solver_failure"
    | "submission_rejection"
    | "delivery_health"
    | "worker_runtime"
    | "observer_integrity";
  identity: Record<string, string | number>;
  fingerprintIdentity: Record<string, string | number>;
  errorCode: string;
  immediateCritical: boolean;
  alertable: boolean;
  events: number;
  firstSeen: number;
  lastSeen: number;
  context: Record<string, string | number>;
};

export type ObserverAlertRow = {
  fingerprint: string;
  source_kind: SourceObservation["sourceKind"];
  severity: "warning" | "critical";
  state: "open" | "resolved";
  error_code: string;
  context_json: string;
  first_seen: string;
  last_seen: string;
  window_started_at: string;
  window_count: number;
  total_count: number;
  last_sent_at: string | null;
  last_sent_severity: "warning" | "critical" | null;
  discord_message_id: string | null;
  next_send_at: string | null;
};
