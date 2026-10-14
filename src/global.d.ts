import type { TurnstileApi } from "./lib/turnstileTokenProvider";
import type { StatsConfig } from "./types";

declare global {
  const __APP_REVISION__: string;
  const __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: boolean;

  interface Window {
    /** Injected only by the staging build; absent everywhere else so the account UI stays off. */
    COLLECTION_ACCOUNT_CONFIG?: { enabled?: boolean };
    COLLECTION_STATS_CONFIG?: StatsConfig;
    turnstile?: TurnstileApi;
  }
}
