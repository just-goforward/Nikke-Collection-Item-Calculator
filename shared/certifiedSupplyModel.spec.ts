import { describe, expect, it } from "vitest";
import {
  dateStart,
  freezeJson,
  isDeeplyFrozen,
  timestamp,
  withSupplyDateCache,
} from "./certifiedSupplyModel.ts";

describe("recursive JSON freezing", () => {
  it("accepts JSON-parsed graphs, arrays and null-prototype objects", () => {
    const parsed = JSON.parse('{"rows":[{"count":1},[2,"x",null,true]],"nested":{"empty":{}}}');
    const bare = Object.assign(Object.create(null), { values: [1, 2] });
    for (const value of [parsed, bare, [parsed.rows, { bare }]]) {
      expect(freezeJson(value)).toBe(value);
      expect(isDeeplyFrozen(value)).toBe(true);
    }
    expect(isDeeplyFrozen(parsed.rows[0])).toBe(true);
    expect(Object.isFrozen(bare.values)).toBe(true);
  });

  it("rejects accessor properties without invoking them", () => {
    let reads = 0;
    const child = { count: 1 };
    const getter = {
      child,
      get mutable() {
        reads += 1;
        return { count: reads };
      },
    };
    expect(() => freezeJson(getter)).toThrow("certified_json_graph_invalid");
    expect(reads).toBe(0);
    expect(isDeeplyFrozen(getter)).toBe(false);
    expect(Object.isFrozen(getter)).toBe(false);
    const setter = Object.defineProperty({}, "value", { set: () => undefined, enumerable: true });
    const hidden = Object.defineProperty({}, "value", { get: () => 1, enumerable: false });
    const nested = { rows: [{ ok: true }, getter] };
    for (const value of [setter, hidden, nested]) {
      expect(() => freezeJson(value)).toThrow("certified_json_graph_invalid");
      expect(isDeeplyFrozen(value)).toBe(false);
    }
  });

  it("rejects non-plain prototypes and functions", () => {
    class Box {
      count = 1;
    }
    const exotic = [
      new Box(),
      new Date(0),
      new Map(),
      Object.create({ inherited: 1 }),
      Object.setPrototypeOf([1], null),
      { callback: () => undefined },
      [() => undefined],
    ];
    for (const value of exotic) {
      expect(() => freezeJson(value)).toThrow("certified_json_graph_invalid");
      expect(isDeeplyFrozen(value)).toBe(false);
    }
  });

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
