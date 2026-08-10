import { describe, expect, it } from "vitest";

import { message } from "../i18n/locale";
import { preserveStickyLoadingText } from "./calculatorProgressLoading";

describe("preserveStickyLoadingText", () => {
  it("updates progress text without forcing the delayed overlay to open", () => {
    expect(
      preserveStickyLoadingText(
        { active: false, text: message("result.loadingDefault") },
        message("result.loadingStates", { count: 100 }),
      ),
    ).toEqual({ active: false, text: message("result.loadingStates", { count: 100 }) });
  });

  it("keeps outcome-specific text while preserving the current visibility", () => {
    const current = { active: true, text: message("result.loadingApplyFailure") } as const;
    expect(preserveStickyLoadingText(current, message("result.loadingFinalize"))).toEqual(current);
  });
});
