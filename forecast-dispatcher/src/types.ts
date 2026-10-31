/// <reference path="../worker-configuration.d.ts" />

export type DispatcherEnvironment = "staging" | "production";

export type DispatcherEnv = Omit<GeneratedForecastDispatcherEnv, "ENVIRONMENT"> & {
  ENVIRONMENT: DispatcherEnvironment;
  DISPATCH_ENABLED: "true" | "false";
  FORECAST_V2_NOTIFICATIONS_ENABLED?: "true" | "false";
  USAGE_GUARD_DB: D1Database;
  PUBLICATION_MODE: "off" | "enabled";
  DISCORD_APPROVAL_CHANNEL_ID: string;
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
  firstSeenAt: string;
  resolvedAt: string | null;
};
