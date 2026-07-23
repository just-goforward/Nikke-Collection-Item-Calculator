import { describe, expect, it } from "vitest";

import { rateBarGeometry } from "./statsPanelModel";

describe("rateBarGeometry", () => {
  it("maps the observed rate and confidence interval onto the centered deviation axis", () => {
    const geometry = rateBarGeometry(
      0.32,
      100,
      { className: "luck-neutral", interval: { high: 0.32, low: 0.28 } },
      0.3,
    );

    expect(geometry.theoreticalPercent).toBe(50);
    expect(geometry.actualPercent).toBeCloseTo(70);
    expect(geometry.intervalLeft).toBeCloseTo(30);
    expect(geometry.intervalRight).toBeCloseTo(70);
    expect(geometry.intervalWidth).toBeCloseTo(40);
  });

  it("clips a confidence interval that extends beyond the visible deviation range", () => {
    const geometry = rateBarGeometry(
      0.3,
      3,
      { className: "luck-neutral", interval: { high: 0.5, low: 0.1 } },
      0.3,
    );

    expect(geometry.intervalLeft).toBe(0);
    expect(geometry.intervalRight).toBe(100);
    expect(geometry.intervalWidth).toBe(100);
  });
});
