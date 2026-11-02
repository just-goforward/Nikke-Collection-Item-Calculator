import type { PublicationEnvironment } from "./forecastPublicationBytes";

/** Build configuration only. Neither a request nor a URL selects online authority.
 * The empty/default build remains bundled; unknown modes never gain online trust.
 */
export function runtimeForecastEnvironment(value: unknown): PublicationEnvironment | null {
  if (value === undefined || value === "" || value === "bundled") return null;
  if (value === "staging" || value === "production") return value;
  throw new Error("forecast_runtime_mode_invalid");
}
