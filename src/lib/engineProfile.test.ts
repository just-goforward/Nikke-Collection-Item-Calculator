import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

// CERTIFIED_ONLY_BUILD is a module-load constant, so each build profile needs a fresh import.
async function routing(runtime: string) {
  vi.stubEnv("VITE_FORECAST_RUNTIME", runtime);
  vi.resetModules();
  return (await import("./engineProfile")).usesCertifiedEngineFromSearch;
}

const queryOverrides = [
  "",
  "?statsEnv=staging",
  "?statsEnv=staging&engine=certified",
  "?statsEnv=production",
  "?statsEnv=disabled",
  "?statsEnv=staging&demoStats=1",
  "?demoStats=1&engine=legacy",
  "?engine=legacy",
  "?engine=certified",
];

describe("calculator engine routing", () => {
  it.each([false, true])(
    "never enables local forecasts in deployed builds (staging=%s)",
    async (staging) => {
      vi.stubEnv("DEV", false);
      await routing(staging ? "staging" : "");
      const { localCertifiedForecastEnabled } = await import("./certifiedLocalPolicy");
      expect(localCertifiedForecastEnabled()).toBe(false);
    },
  );
  it("enables the unsigned policy only in the local non-publication dev server", async () => {
    vi.stubEnv("DEV", true);
    await routing("");
    const { localCertifiedForecastEnabled } = await import("./certifiedLocalPolicy");
    expect(localCertifiedForecastEnabled()).toBe(true);
    vi.stubEnv("VITE_FORECAST_RUNTIME", "staging");
    expect(localCertifiedForecastEnabled()).toBe(false);
  });
  it.each(queryOverrides)(
    "staging builds always select the certified calculator for %j",
    async (search) => {
      const usesCertifiedEngineFromSearch = await routing("staging");
      expect(usesCertifiedEngineFromSearch(search)).toBe(true);
    },
  );

  it("production builds keep the legacy calculator unless the existing review query opts in", async () => {
    const usesCertifiedEngineFromSearch = await routing("");
    const certified = queryOverrides.filter(usesCertifiedEngineFromSearch);
    expect(certified).toEqual(["?statsEnv=staging&engine=certified"]);
  });

  it("does not treat other runtime values as a staging build", async () => {
    const usesCertifiedEngineFromSearch = await routing("off");
    expect(usesCertifiedEngineFromSearch("")).toBe(false);
    expect(usesCertifiedEngineFromSearch("?engine=certified")).toBe(false);
  });
});
