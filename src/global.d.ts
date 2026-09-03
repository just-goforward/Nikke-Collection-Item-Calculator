import type { TurnstileApi } from "./lib/turnstileTokenProvider";
import type { StatsConfig } from "./types";

declare global {
  const __APP_REVISION__: string;
  const __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: boolean;

  interface Window {
    COLLECTION_STATS_CONFIG?: StatsConfig;
    turnstile?: TurnstileApi;
  }
}
