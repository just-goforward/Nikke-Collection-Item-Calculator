import type { SupplyForecastCandidate } from "../../shared/supplyForecastCandidate";

export type CollectorEnv = {
  FORECAST_DB: D1Database;
  ADMIN_RATE_LIMITER?: RateLimit;
  ADMIN_TOKEN: string;
  ENVIRONMENT: "test" | "staging" | "production";
  DEPLOY_SHA: string;
  POLL_MODE: "both" | "alternating";
  COLLECT_ENABLED?: "true" | "false";
  DISCORD_APPROVAL_MODE?: "disabled" | "test" | "staging_adoption";
  DISCORD_INTERACTION_OWNER?: "collector" | "router";
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_APPROVER_USER_ID?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_CHANNEL_ID?: string;
};

export type SourceKind = "naver-board-48" | "naver-board-56" | "x-nikke-kr";
export type NaverSourceKind = Extract<SourceKind, `naver-${string}`>;

export type NaverFeedMetadata = {
  source: NaverSourceKind;
  itemId: string;
  url: string;
  title: string;
  publishedAt: string;
  official: boolean;
};

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
  polledSources: number;
  queuedItems: number;
};

export type SourceQueueItem = NaverFeedMetadata & {
  status: "pending" | "processed" | "ignored" | "manual_review";
  attempts: number;
  errorCode: string | null;
};

export type SourceQueueResult = {
  source: NaverSourceKind;
  itemId: string;
  outcome: "processed" | "ignored" | "manual_review" | "retry";
  errorCode?: string;
  item?: NormalizedSourceItem;
  event?: ScheduleEvent;
};
/// <reference path="../worker-configuration.d.ts" />
