import { supplyForecastEnvironment } from "./supplyForecastRuntime";

/** Query flags never independently choose a schema, solver, price, or data environment. */
export function usesCertifiedEngineFromSearch(search: string) {
  return (
    supplyForecastEnvironment(search) === "staging" &&
    new URLSearchParams(search).get("engine") === "certified"
  );
}
