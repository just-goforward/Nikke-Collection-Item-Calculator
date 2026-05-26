import { StatsConfigSchema } from "../schemas";

export function statsApiBase(): string {
  const parsed = StatsConfigSchema.safeParse(window.COLLECTION_STATS_CONFIG || {});
  return parsed.success && typeof parsed.data.endpoint === "string"
    ? parsed.data.endpoint.replace(/\/+$/, "")
    : "";
}

export function statsSubmissionConfig(): { endpoint: string; turnstileSiteKey: string } | null {
  const parsed = StatsConfigSchema.safeParse(window.COLLECTION_STATS_CONFIG || {});
  if (!parsed.success || !parsed.data.endpoint || !parsed.data.turnstileSiteKey) return null;
  return {
    endpoint: parsed.data.endpoint.replace(/\/+$/, ""),
    turnstileSiteKey: parsed.data.turnstileSiteKey,
  };
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
  } catch {
    return "unknown";
  }
}
