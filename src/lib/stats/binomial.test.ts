import { describe, expect, it } from "vitest";

import { wilsonInterval } from "./binomial";

describe("wilsonInterval", () => {
  it("returns a bounded interval around the observed proportion", () => {
    const interval = wilsonInterval(29, 658);

    expect(interval.low).toBeGreaterThanOrEqual(0);
    expect(interval.high).toBeLessThanOrEqual(1);
    expect(interval.low).toBeLessThan(29 / 658);
    expect(interval.high).toBeGreaterThan(29 / 658);
  });

  it("handles empty samples without producing NaN", () => {
    expect(wilsonInterval(0, 0)).toEqual({ high: 0, low: 0 });
  });

  it("clamps impossible inputs to the valid binomial range", () => {
    const interval = wilsonInterval(20, 10);

    expect(interval.low).toBeGreaterThan(0);
    expect(interval.high).toBe(1);
  });
});
