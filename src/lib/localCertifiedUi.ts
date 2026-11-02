/** Internal dev entry only; never a query/storage opt-in or a staging override. */
export function localCertifiedUiEnabled(hostname: string): boolean {
  return (
    import.meta.env.DEV === true &&
    import.meta.env.MODE === "current-ui-certified-local" &&
    runtimeForecastEnvironment(import.meta.env.VITE_FORECAST_RUNTIME) === null &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]")
  );
}
import { runtimeForecastEnvironment } from "../../shared/runtimeForecastMode";

