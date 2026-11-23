import type { TurnstileApi } from "./lib/turnstileTokenProvider";
import type { StatsConfig } from "./types";

declare global {
  const __APP_REVISION__: string;
  const __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: boolean;

  interface ImportMetaEnv {
    /** Supplied and validated by the isolated root candidate build, never a runtime setting. */
    readonly VITE_ROOT_CONDITIONAL_PUBLIC_KEY: string;
  }

  interface Window {
    /** Injected only by the staging build; absent everywhere else so the account UI stays off. */
    COLLECTION_ACCOUNT_CONFIG?: { enabled?: boolean };
    COLLECTION_STATS_CONFIG?: StatsConfig;
    turnstile?: TurnstileApi;
  }
}
