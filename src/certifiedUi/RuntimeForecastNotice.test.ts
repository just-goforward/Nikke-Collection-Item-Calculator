import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeForecastStatus } from "../lib/runtimeForecast";
import { RuntimeForecastNotice } from "./RuntimeForecastNotice";

const state = vi.hoisted(() => ({
  locale: "ko" as "ko" | "en" | "ja",
  status: "off" as RuntimeForecastStatus,
}));
vi.mock("../i18n/locale", () => ({ useI18n: () => ({ locale: state.locale }) }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [state.status, () => {}],
}));

describe("rendered runtime fallback notice", () => {
  it.each([
    ["ko", "공급 예측이 업데이트되지 않았습니다. 앱에 포함된 예측을 사용합니다."],
    ["en", "Forecast not updated. Using the bundled forecast."],
    ["ja", "供給予測は更新されていません。アプリ内蔵の予測を使用します。"],
  ] as const)("renders both off and unavailable in %s", (locale, expected) => {
    state.locale = locale;
    for (const status of ["off", "unavailable"] as const) {
      state.status = status;
      const html = renderToStaticMarkup(createElement(RuntimeForecastNotice));
      expect(html).toContain(expected);
      expect(html).toContain('role="status"');
      expect(html).toContain(`data-runtime-forecast="${status}"`);
    }
  });
  it.each(["active", "bundled", "checking"] as const)(
    "does not announce fallback for %s",
    (status) => {
      state.status = status;
      expect(renderToStaticMarkup(createElement(RuntimeForecastNotice))).toBe("");
    },
  );
});
