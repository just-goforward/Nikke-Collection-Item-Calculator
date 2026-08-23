import type { BrowserEndpoint } from "@cloudflare/playwright";
import type { SupplyForecastCandidate } from "../../shared/supplyForecastCandidate";

export type CollectorEnv = {
  FORECAST_DB: D1Database;
  BROWSER: BrowserEndpoint;
  ADMIN_RATE_LIMITER?: RateLimit;
  ADMIN_TOKEN: string;
  ENVIRONMENT: "test" | "staging" | "production";
  DEPLOY_SHA: string;
  X_AUTOMATION_ENABLED: "true" | "false";
};

export type SourceKind = "naver-board-48" | "naver-board-56" | "x-nikke-kr";

export type NormalizedSourceItem = {
  source: SourceKind;
  itemId: string;
  url: string;
  title: string;
  excerpt: string;
  normalizedText: string;
  publishedAt: string;
  contentHash: string;
  structured: boolean;
  official: boolean;
};

export type ScheduleEvent = {
  eventId: string;
  eventType: "solo" | "cooperation" | "collaboration" | "schedule_change" | "reward";
  sourceItem: NormalizedSourceItem;
  startsAt: string | null;
  endsAt: string | null;
  scheduleStatus: "confirmed" | "estimated";
  manualReview: boolean;
  reason: string | null;
};

export type XProbeResult = {
  status: "crosschecked" | "x_unavailable" | "conflict";
  sourceItem: NormalizedSourceItem | null;
  reason: string | null;
};

export type CandidateBuildResult = {
  candidate: SupplyForecastCandidate;
  payloadHash: string;
};

export type CollectionSummary = {
  outcome: "completed" | "circuit_open" | "failure";
  naverItems: number;
  parsedEvents: number;
  candidates: number;
  xStatus: XProbeResult["status"] | "not_run";
};
