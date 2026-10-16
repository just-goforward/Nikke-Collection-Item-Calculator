/// <reference types="vite/client" />
declare global {
  interface ImportMetaEnv {
    readonly VITE_FORECAST_RUNTIME?: string;
    readonly VITE_FORECAST_PUBLIC_KEY_ID?: string;
    readonly VITE_FORECAST_PUBLIC_KEY_BASE64?: string;
  }
}
// Trust is compiled into BOTH the browser and certified Worker. Never read keys from
// a response, URL, storage, or a calculation request. Production has no staging opt-in.
export const runtimeForecastEnabled =
  typeof import.meta.env !== "undefined" && import.meta.env.VITE_FORECAST_RUNTIME === "staging";
export const runtimeForecastConfig = {
  enabled: runtimeForecastEnabled,
  trust: {
    environment: "staging" as const,
    keyId: import.meta.env?.VITE_FORECAST_PUBLIC_KEY_ID ?? "",
    publicKeyBase64: import.meta.env?.VITE_FORECAST_PUBLIC_KEY_BASE64 ?? "",
  },
};
