import type { TurnstileApi } from "./lib/turnstileTokenProvider";
import type { StatsConfig } from "./types";

declare global {
  interface Window {
    COLLECTION_STATS_CONFIG?: StatsConfig;
    turnstile?: TurnstileApi;
  }
}
