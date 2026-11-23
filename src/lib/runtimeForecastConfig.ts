/// <reference types="vite/client" />
import { runtimeForecastEnvironment } from "../../shared/runtimeForecastMode";

declare global {
  interface ImportMetaEnv {
    readonly VITE_FORECAST_RUNTIME?: string;
    readonly VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID?: string;
    readonly VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64?: string;
    readonly VITE_PREVIEW_LEGACY_D0?: string;
  }
}
// Trust is compiled into BOTH the browser and certified Worker. Never read keys from
// a response, URL, storage, or a calculation request. Online production is explicit.
const environment = runtimeForecastEnvironment(import.meta.env?.VITE_FORECAST_RUNTIME);
export const runtimeForecastEnabled = environment !== null;
// Fixed read capability. Never obtain either key or environment from the request or publication.
export const previewLegacyD0Enabled = import.meta.env?.BASE_URL === "/preview/" &&
  environment === "staging" && import.meta.env?.VITE_PREVIEW_LEGACY_D0 === "true";
export const previewLegacyD0Trust = Object.freeze({
  environment: "production" as const, channel: "legacy" as const, keyId: "production-v1",
  publicKeyBase64: "BJAu/55jE5vGF7axWWKIp3RbjZyjm1QPY4IuqSzMf9Y=",
});
export const runtimeForecastConfig = {
  enabled: runtimeForecastEnabled,
  trust: {
    // In bundled mode this inert trust object is never used for verification.
    environment: environment ?? "staging",
    channel: "timed-v1" as const,
    keyId: import.meta.env?.VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID ?? "",
    publicKeyBase64: import.meta.env?.VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64 ?? "",
  },
};
