import { describe, expect, it } from "vitest";
import { medianCadence, medianPrediction } from "./median.ts";

describe("independent median arithmetic", () => {
  it("retains an exact even median and floors only prediction days", () => {
    expect(medianCadence(["2026-01-01", "2026-01-22", "2026-02-19"])).toEqual({
      numerator: 49n,
      denominator: 2n,
      predictionDays: 24,
    });
  });
  const dates = ["2026-08-20", "2026-09-17", "2026-10-15"];
  const predict = (at: string) =>
    medianPrediction(dates, "2026-10-15T03:00:00Z", "2026-10-21T19:59:59Z", at);
  it.each([
    ["2026-11-12T02:59:59Z", 0, "2026-11-12T03:00:00.000Z"],
    ["2026-11-12T03:00:00Z", 0, "2026-11-12T03:00:00.000Z"],
    ["2026-11-12T03:00:00.001Z", 1, "2026-11-13T03:00:00.000Z"],
    ["2026-11-12T19:59:59Z", 1, "2026-11-13T03:00:00.000Z"],
    ["2026-11-12T20:00:00Z", 2, "2026-11-14T03:00:00.000Z"],
  ])("waiting boundary %s", (at, offsetDays, start) => {
    expect(predict(at)).toMatchObject({ offsetDays, start });
    expect(Date.parse(predict(at).end) - Date.parse(start)).toBe(579599000);
  });
  it("rejects unordered history and an unrelated anchor", () => {
    expect(() => medianCadence(["2026-01-02", "2026-01-01"])).toThrow();
    expect(() =>
      medianPrediction(dates, "2026-10-16T03:00:00Z", "2026-10-22T19:59:59Z", dates[0]!),
    ).toThrow();
  });
});
