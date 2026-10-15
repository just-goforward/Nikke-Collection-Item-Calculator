import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import App from "../App";
import { I18nProvider, translate } from "../i18n/locale";
import { usesCertifiedEngineFromSearch } from "./engineProfile";
import {
  prepareRuntimeSupplyForecast,
  resolveRuntimeSupplyForecast,
  SUPPLY_UNAVAILABLE_MESSAGE,
} from "./supplyForecastRuntime";

vi.mock("../../shared/generated/supplyForecastRuntime", () => ({
  STAGING_SUPPLY_FORECAST_ID: "supply-2026-10-15-v99",
  STAGING_SUPPLY_FORECAST: { id: "supply-2026-10-15-v99", profiles: [] },
}));

beforeAll(async () => {
  const location = new URL("https://example.test/en/?statsEnv=staging");
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", {
    location,
    localStorage: { getItem: () => null },
    COLLECTION_STATS_CONFIG: {
      staging: { endpoint: "https://stats.example.test", turnstileSiteKey: "test-key" },
    },
  });
  await prepareRuntimeSupplyForecast(location.search);
});
afterAll(() => vi.unstubAllGlobals());

describe("legacy route without usable projected supply", () => {
  it.each(["ko", "ja", "en"] as const)(
    "renders calculation unavailability in %s without a module-load or render failure",
    (locale) => {
      location.pathname = locale === "ko" ? "/" : `/${locale}/`;
      expect(usesCertifiedEngineFromSearch(location.search)).toBe(false);
      expect(() => resolveRuntimeSupplyForecast()).toThrow(SUPPLY_UNAVAILABLE_MESSAGE);
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(App)));
      expect(html).toContain(
        `<span role="alert">${translate(locale, "staging.supplyUnavailable")}</span>`,
      );
      expect(html).not.toContain("boot-error");
      expect(html).not.toContain("data-engine-profile");
      expect(html).not.toContain("NaN");
    },
  );
});
