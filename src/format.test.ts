import { describe, expect, it } from "vitest";

import { formatFlooredPercent, formatInteger, formatNumber } from "./format";

describe("number formatting", () => {
  it("preserves fixed decimal and integer formatting through cached formatters", () => {
    expect(formatNumber(1234.5, 2)).toBe("1,234.50");
    expect(formatNumber(1234.5, 1)).toBe("1,234.5");
    expect(formatInteger(1234.5)).toBe("1,235");
  });

  it("preserves non-finite and floored percent behavior", () => {
    expect(formatNumber(Number.NaN)).toBe("-");
    expect(formatFlooredPercent(0.12399, 1)).toBe("12.3%");
  });
});
