import { describe, expect, it } from "vitest";

import { localeFromLanguageTag, message, translate, translateMessage } from "./locale";

describe("locale selection", () => {
  it.each([
    ["ko", "ko"],
    ["ko-KR", "ko"],
    ["en-US", "en"],
    ["ja-JP", "ja"],
    ["fr-FR", null],
    [null, null],
  ] as const)("maps %s to %s", (language, expected) => {
    expect(localeFromLanguageTag(language)).toBe(expected);
  });
});

describe("message catalogs", () => {
  it("uses locale-aware number formatting for numeric parameters", () => {
    expect(translate("en", "validation.progress", { count: 12_000 })).toBe(
      "12,000 simulated Commanders have finished.",
    );
    expect(translate("ja", "validation.progress", { count: 12_000 })).toBe(
      "仮想指揮官12,000人が試行を完了しました。",
    );
  });

  it("translates a stored message descriptor without rebuilding its view model", () => {
    const stored = message("detail.rankCandidate", { rank: 2 });
    expect(translateMessage("ko", stored)).toBe("후보 2");
    expect(translateMessage("en", stored)).toBe("Option 2");
    expect(translateMessage("ja", stored)).toBe("候補2");
  });
});
