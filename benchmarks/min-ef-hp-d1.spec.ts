import { describe, expect, it } from "vitest";

import {
  classifyD1ProfilePasses,
  type D1HpStratum,
  replayD1Stratum,
  representativeStock,
  selectD1HpStrata,
} from "./min-ef-hp-d1";

function row(events: number, blue: D1HpStratum["stockBuckets"]["blue"]): D1HpStratum {
  return {
    grade: "SR",
    level: 10,
    expBucket: 0,
    stockBuckets: { blue, purple: "100_149", yellow: "50_99" },
    events,
    firstDate: "2026-07-01",
    lastDate: "2026-08-01",
  };
}

describe("H/p D1 robustness strata", () => {
  it("keeps top coverage and low/high risk strata", () => {
    const selected = selectD1HpStrata([
      row(70, "100_149"),
      row(20, "200_249"),
      row(5, "1_49"),
      row(5, "500_plus"),
    ]);
    expect(selected.coverage).toBe(1);
    expect(selected.rows).toHaveLength(4);
  });

  it("maps finite and right-censored buckets to low, mid, and high representatives", () => {
    expect(representativeStock("1_49", "finite_low")).toBe(1);
    expect(representativeStock("1_49", "finite_mid")).toBe(25);
    expect(representativeStock("1_49", "finite_high")).toBe(49);
    expect(representativeStock("500_plus", "censored_500")).toBe(500);
    expect(representativeStock("500_plus", "finite_mid")).toBe(750);
    expect(representativeStock("500_plus", "censored_1000")).toBe(1000);
  });

  it("replays a joint bucket profile without using derived diagnostic fields", () => {
    const scenario = replayD1Stratum(row(10, "500_plus"), "finite_mid");
    expect(scenario.start).toEqual({ grade: "SR", level: 10, exp: 0 });
    expect(scenario.stock).toEqual({ blue: 750, purple: 125, yellow: 75 });
  });

  it("separates finite-bucket failure from right-censoring uncertainty", () => {
    const passing = [
      { profile: "finite_low", passed: true },
      { profile: "finite_mid", passed: true },
      { profile: "finite_high", passed: false },
      { profile: "censored_500", passed: true },
      { profile: "censored_1000", passed: true },
    ] as const;
    expect(classifyD1ProfilePasses(passing)).toBe("failed");
    expect(
      classifyD1ProfilePasses(
        passing.map((entry) =>
          entry.profile === "censored_1000" ? { ...entry, passed: false } : entry,
        ),
      ),
    ).toBe("right_censoring_sensitive");
  });
});
