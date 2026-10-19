import { supplyForecastEnvironment } from "./supplyForecastRuntime";

/** Staging site builds are pinned at compile time to the certified calculator: no query
 * (statsEnv, demoStats, engine) can select the legacy calculator or its bundled forecast.
 * A compile-time constant, so staging bundles omit the legacy calculator entirely.
 */
export const CERTIFIED_ONLY_BUILD = import.meta.env.VITE_FORECAST_RUNTIME === "staging";

/** Query flags never independently choose a schema, solver, price, or data environment. */
export function usesCertifiedEngineFromSearch(search: string) {
  return (
    CERTIFIED_ONLY_BUILD ||
    (supplyForecastEnvironment(search) === "staging" &&
      new URLSearchParams(search).get("engine") === "certified")
  );
}
