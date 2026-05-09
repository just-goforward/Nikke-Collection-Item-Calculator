import type { StatsConfig } from "./types";

declare global {
  interface Window {
    COLLECTION_STATS_CONFIG?: StatsConfig;
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      execute: (widgetId: string, options?: Record<string, unknown>) => void;
    };
  }
}

export {};
