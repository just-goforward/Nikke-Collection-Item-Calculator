import type { TurnstileApi } from "./lib/turnstileTokenProvider";
import type { StatsConfig } from "./types";

declare global {
  const __SOURCE_REVISION__: string;

  interface Window {
    COLLECTION_STATS_CONFIG?: StatsConfig;
    turnstile?: TurnstileApi;
  }
}
