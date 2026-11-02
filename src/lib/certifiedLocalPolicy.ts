import { runtimeForecastEnvironment } from "../../shared/runtimeForecastMode";

/** Only a Vite dev server may use the unsigned policy. Queries, storage and request
 * metadata cannot opt a deployed bundle (or a Node Worker) into this branch. */
export function localCertifiedForecastEnabled(): boolean {
  return import.meta.env?.DEV === true &&
    runtimeForecastEnvironment(import.meta.env.VITE_FORECAST_RUNTIME) === null;
}
