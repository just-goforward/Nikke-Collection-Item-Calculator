import {
  STAGING_RUNTIME_QUERY_KEY,
  STAGING_RUNTIME_QUERY_VALUE,
} from "../../shared/runtimeEnvironment";
import type { StatsConfig, StatsEndpointConfig } from "../types";
import { ignoreExpectedError } from "./errorHandling";

export type StatsRuntimeMode =
  | "production"
  | "staging"
  | "demo"
  | "disabled"
  | "staging-misconfigured";

type SubmissionConfig = { endpoint: string; turnstileSiteKey: string };
type StatsConfigRecord = Record<string, unknown> & {
  endpoint?: unknown;
  staging?: unknown;
  turnstileSiteKey?: unknown;
};

type ParsedStatsConfig =
  | { success: true; data: StatsConfig }
  | { success: false; data?: undefined };

function isRecord(value: unknown): value is StatsConfigRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).toString();
  } catch {
    return undefined;
  }
}

function normalizedNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function endpointConfig(value: unknown): StatsEndpointConfig | undefined {
  if (!isRecord(value)) return undefined;
  const config: StatsEndpointConfig = {};
  const endpoint = normalizedUrl(value.endpoint);
  const turnstileSiteKey = normalizedNonEmptyString(value.turnstileSiteKey);
  if (endpoint) config.endpoint = endpoint;
  if (turnstileSiteKey) config.turnstileSiteKey = turnstileSiteKey;
  return config;
}

function parsedStatsConfig(): ParsedStatsConfig {
  const raw = window.COLLECTION_STATS_CONFIG || {};
  if (!isRecord(raw)) return { success: false };
  const base = endpointConfig(raw);
  if (!base) return { success: false };
  const staging = endpointConfig(raw.staging);
  return {
    success: true,
    data: {
      ...base,
      ...(staging ? { staging } : {}),
    },
  };
}

function normalizedEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function completeSubmissionConfig(config?: {
  endpoint?: string | undefined;
  turnstileSiteKey?: string | undefined;
}): SubmissionConfig | null {
  if (!config?.endpoint || !config.turnstileSiteKey) return null;
  return {
    endpoint: normalizedEndpoint(config.endpoint),
    turnstileSiteKey: config.turnstileSiteKey,
  };
}

function isLocalHost(hostname?: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function statsRuntimeMode(): StatsRuntimeMode {
  const params = new URLSearchParams(window.location.search);
  if (params.get("demoStats") === "1") return "demo";
  if (params.get(STAGING_RUNTIME_QUERY_KEY) === "disabled") return "disabled";
  const statsEnv = params.get(STAGING_RUNTIME_QUERY_KEY);
  if (statsEnv !== STAGING_RUNTIME_QUERY_VALUE) {
    if (!statsEnv && isLocalHost(window.location.hostname)) return "disabled";
    return "production";
  }

  const parsed = parsedStatsConfig();
  if (!parsed.success || !completeSubmissionConfig(parsed.data.staging)) {
    return "staging-misconfigured";
  }
  return "staging";
}

export function statsApiBase(): string {
  const mode = statsRuntimeMode();
  if (mode === "demo" || mode === "disabled" || mode === "staging-misconfigured") return "";

  const parsed = parsedStatsConfig();
  if (!parsed.success) return "";
  if (mode === "staging") return normalizedEndpoint(parsed.data.staging?.endpoint || "");
  return parsed.data.endpoint ? normalizedEndpoint(parsed.data.endpoint) : "";
}

export function statsSubmissionConfig(): SubmissionConfig | null {
  const mode = statsRuntimeMode();
  if (mode === "demo" || mode === "disabled" || mode === "staging-misconfigured") return null;

  const parsed = parsedStatsConfig();
  if (!parsed.success) return null;
  return completeSubmissionConfig(mode === "staging" ? parsed.data.staging : parsed.data);
}

export function makeStatsEventId(): string {
  const randomPart =
    window.crypto && typeof window.crypto.getRandomValues === "function"
      ? Array.from(window.crypto.getRandomValues(new Uint32Array(2)))
          .map((value) => value.toString(16))
          .join("")
      : Math.random().toString(16).slice(2);
  return `${Date.now().toString(36)}-${randomPart}`;
}

export function statsSourceHost(): string {
  try {
    if (!document.referrer) return "direct";
    const referrer = new URL(document.referrer);
    if (referrer.host === window.location.host) return "same-site";
    return referrer.host || "unknown";
  } catch (error) {
    ignoreExpectedError("document.referrer may not be a parseable URL", error);
    return "unknown";
  }
}
