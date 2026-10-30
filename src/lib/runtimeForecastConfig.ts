/// <reference types="vite/client" />
import { runtimeForecastEnvironment } from "../../shared/runtimeForecastMode";

declare global {
  interface ImportMetaEnv {
    readonly VITE_FORECAST_RUNTIME?: string;
    readonly VITE_FORECAST_PUBLIC_KEY_ID?: string;
    readonly VITE_FORECAST_PUBLIC_KEY_BASE64?: string;
  }
}
// Trust is compiled into BOTH the browser and certified Worker. Never read keys from
// a response, URL, storage, or a calculation request. Online production is explicit.
const environment = runtimeForecastEnvironment(import.meta.env?.VITE_FORECAST_RUNTIME);
export const runtimeForecastEnabled = environment !== null;
export const runtimeForecastConfig = {
  enabled: runtimeForecastEnabled,
  trust: {
    // In bundled mode this inert trust object is never used for verification.
    environment: environment ?? "staging",
    keyId: import.meta.env?.VITE_FORECAST_PUBLIC_KEY_ID ?? "",
    publicKeyBase64: import.meta.env?.VITE_FORECAST_PUBLIC_KEY_BASE64 ?? "",
  },
};
