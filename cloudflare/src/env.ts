import type { AnalyticsEnv } from "./decision-analytics-handler.ts";
import type { AnalyticsMaintenanceEnv } from "./decision-analytics-maintenance.ts";
import type { OutcomeEnv } from "./outcome-handler.ts";
import type { RawReaderEnv } from "./outcome-raw-reader.ts";

export type WorkerEnv = GeneratedWorkerEnv & AnalyticsEnv & AnalyticsMaintenanceEnv & OutcomeEnv & RawReaderEnv & {
  ADMIN_TOKEN?: string;
  DEPLOYMENT_SHA?: string;
  FORECAST_DB?: D1Database;
  SITE_ENV?: string;
};
