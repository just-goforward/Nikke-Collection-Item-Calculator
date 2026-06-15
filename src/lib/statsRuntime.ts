import { StatsConfigSchema } from "../schemas";
import { ignoreExpectedError } from "./errorHandling";

export type StatsRuntimeMode =
  | "production"
  | "staging"
  | "demo"
  | "disabled"
  | "staging-misconfigured";

type SubmissionConfig = { endpoint: string; turnstileSiteKey: string };

function parsedStatsConfig() {
  return StatsConfigSchema.safeParse(window.COLLECTION_STATS_CONFIG || {});
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

export function statsRuntimeMode(): StatsRuntimeMode {
  const params = new URLSearchParams(window.location.search);
  if (params.get("demoStats") === "1") return "demo";
  if (params.get("statsEnv") === "disabled") return "disabled";
  if (params.get("statsEnv") !== "staging") return "production";

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
