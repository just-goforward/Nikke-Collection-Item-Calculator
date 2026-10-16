import { describe, expect, it } from "vitest";
import { dateStart, freezeJson, timestamp, withSupplyDateCache } from "./certifiedSupplyModel.ts";

describe("recursive JSON freezing", () => {
  it("freezes shared descendants even when callers have frozen only their parent", () => {
    const child = { values: [{ count: 1 }] };
    const shallow = Object.freeze({ child });
    const value = { shallow, duplicate: child };
    expect(freezeJson(value)).toBe(value);
    for (const object of [value, shallow, child, child.values, child.values[0]])
      expect(Object.isFrozen(object)).toBe(true);
    const next = { previous: value, fresh: { count: 2 } };
    expect(freezeJson(next)).toBe(next);
    expect(Object.isFrozen(next.fresh)).toBe(true);
    const first = child.values[0];
    if (!first) throw new Error("missing_child");
    expect(() => {
      first.count = 9;
    }).toThrow(TypeError);
    expect(child.values[0]?.count).toBe(1);
  });
});

describe("scoped supply date conversions", () => {
  it("retains offset, leap-day, zero-epoch and invalid-input semantics across nested operations", () => {
    const check = () => {
      expect(timestamp("1970-01-01T00:00:00Z")).toBe(0);
      expect(timestamp("1970-01-01T09:00:00+09:00")).toBe(0);
      expect(dateStart("2024-02-29")).toBe(Date.parse("2024-02-28T20:00:00Z"));
      expect(() => dateStart("2023-02-29")).toThrow("certified_game_date_invalid");
      expect(() => timestamp("2026-08-20T05:00:00")).toThrow("certified_timestamp_offset_required");
      expect(() => timestamp("not-a-dateZ")).toThrow("certified_timestamp_invalid");
    };
    withSupplyDateCache(() => {
      check();
      withSupplyDateCache(check);
      check();
    });
    expect(() =>
      withSupplyDateCache(() => {
        check();
        throw new Error("operation_failed");
      }),
    ).toThrow("operation_failed");
    check();
    withSupplyDateCache(check);
  });
});
