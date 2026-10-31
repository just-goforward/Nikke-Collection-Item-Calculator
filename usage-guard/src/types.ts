/// <reference path="../worker-configuration.d.ts" />

export type UsageGuardEnv = GeneratedUsageGuardEnv;

export type StoredGuardState = {
  action: string;
  observed_at: string;
  period_start: string;
  period_end: string;
  evidence_json: string;
  evidence_hash: string;
  current_percent: number;
  projected_percent: number;
  governing_metric: string;
  normal_streak: number;
  release_pending: number;
  last_alert_action: string | null;
};

export type StoredSnapshot = {
  snapshot_json: string;
  snapshot_hash: string;
  captured_at: string;
};
