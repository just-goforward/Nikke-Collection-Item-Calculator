import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeForecastStatus } from "../lib/runtimeForecast";
import { RuntimeForecastNotice } from "./RuntimeForecastNotice";

const state = vi.hoisted(() => ({
  locale: "ko" as "ko" | "en" | "ja",
  status: "off" as RuntimeForecastStatus,
  retrying: false,
  calls: 0,
}));
vi.mock("../i18n/locale", () => ({ useI18n: () => ({ locale: state.locale }) }));
vi.mock("../lib/runtimeForecast", () => ({
  runtimeForecast: { subscribe: () => () => {}, refresh: async () => {} },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  // First useState is the publication status, the second the retry progress.
  useState: () => [state.calls++ % 2 === 0 ? state.status : state.retrying, () => {}],
}));

function render() {
  state.calls = 0;
  return renderToStaticMarkup(createElement(RuntimeForecastNotice));
}

describe("rendered fail-closed runtime forecast notice", () => {
  it.each([
    ["ko", "앱에 포함된 예측으로 대체하지 않습니다", "다시 확인"],
    ["en", "The bundled forecast is not used.", "Check again"],
    ["ja", "アプリ内蔵の予測では代替しません", "再確認"],
  ] as const)(
    "announces unavailability with a retry for off and unavailable in %s",
    (locale, text, retry) => {
      state.locale = locale;
      state.retrying = false;
      for (const status of ["off", "unavailable"] as const) {
        state.status = status;
        const html = render();
        expect(html).toContain(text);
        expect(html).toContain('role="alert"');
        expect(html).toContain(`data-runtime-forecast="${status}"`);
        expect(html).toContain(`<button type="button" class="cert-button">${retry}</button>`);
        expect(html).not.toMatch(/Using the bundled forecast|앱에 포함된 예측을 사용합니다/);
      }
    },
  );
  it("disables the retry while a check is in flight", () => {
    state.locale = "en";
    state.status = "unavailable";
    state.retrying = true;
    expect(render()).toContain('<button type="button" class="cert-button" disabled="">Checking…');
  });
  it.each(["active", "bundled", "checking"] as const)("stays silent for %s", (status) => {
    state.status = status;
    expect(render()).toBe("");
  });
});
