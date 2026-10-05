import { describe, expect, it } from "vitest";
import { saveLegacyInputRecovery } from "./lazyModuleRetry";
import { consumeLegacyInputRecovery } from "./legacyInputRecovery";

const key = "nikke:legacy-reload-input:v1";
const url = "/?statsEnv=disabled";
const now = 1_800_000_000_000;
const input = {
  grade: "SR" as const,
  level: 14,
  exp: 1200,
  stock: { blue: 123, purple: 24, yellow: 50 },
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
  };
}

describe("one-shot legacy reload input recovery", () => {
  it("stores pending confirmation without pre-use inputs and consumes only a warning", () => {
    const storage = memoryStorage();
    expect(saveLegacyInputRecovery("pending", storage, url, now)).toBe(true);
    expect(JSON.parse(storage.getItem(key) ?? "")).toEqual({
      schema: 1,
      revision: "legacy-input-v1",
      savedAt: now,
      url,
      input: "pending",
    });
    expect(consumeLegacyInputRecovery(storage, url, now)).toBe("pending");
    expect(consumeLegacyInputRecovery(storage, url, now)).toBeNull();
  });
  it("replaces pending confirmation with exact settled post-use inputs", () => {
    const storage = memoryStorage();
    const settled = { ...input, level: 15, exp: 0, stock: { ...input.stock, blue: 93 } };
    expect(saveLegacyInputRecovery("pending", storage, url, now)).toBe(true);
    expect(saveLegacyInputRecovery(settled, storage, url, now + 100)).toBe(true);
    expect(consumeLegacyInputRecovery(storage, url, now + 101)).toEqual(settled);
  });
  it.each([
    { schema: 2 },
    { revision: "old-input-contract" },
    { savedAt: now - 300_000 },
    { savedAt: now + 1 },
    { url: "/?engine=certified" },
    { result: {} },
    { notice: { ko: "forged session guidance" } },
    { input: "settled" },
    { input: { pending: true, ...input } },
  ])("rejects an invalid pending confirmation marker: %j", (change) => {
    const storage = memoryStorage();
    saveLegacyInputRecovery("pending", storage, url, now);
    storage.setItem(key, JSON.stringify({ ...JSON.parse(storage.getItem(key) ?? ""), ...change }));
    expect(consumeLegacyInputRecovery(storage, url, now)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });
  it("restores exact current inputs once, within expiry, without storing results", () => {
    const storage = memoryStorage();
    expect(saveLegacyInputRecovery(input, storage, url, now)).toBe(true);
    expect(JSON.parse(storage.getItem(key) ?? "")).toEqual({
      schema: 1,
      revision: "legacy-input-v1",
      savedAt: now,
      url,
      input,
    });
    expect(consumeLegacyInputRecovery(storage, url, now + 299_999)).toEqual(input);
    expect(consumeLegacyInputRecovery(storage, url, now + 299_999)).toBeNull();
  });
  it.each([
    { schema: 2 },
    { revision: "old-input-contract" },
    { savedAt: now - 300_000 },
    { savedAt: now + 1 },
    { url: "/?engine=certified" },
    { result: { type: "recommendation" } },
  ])("consumes and rejects incompatible, stale or output-bearing recovery: %j", (change) => {
    const storage = memoryStorage();
    saveLegacyInputRecovery(input, storage, url, now);
    storage.setItem(key, JSON.stringify({ ...JSON.parse(storage.getItem(key) ?? ""), ...change }));
    expect(consumeLegacyInputRecovery(storage, url, now)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });
  it.each([
    { grade: "SSR" },
    { level: 16 },
    { level: 2.5 },
    { level: 15, exp: 100 },
    { exp: 3000 },
    { exp: 150 },
    { stock: { blue: -1, purple: 24, yellow: 50 } },
    { stock: { blue: 100_001, purple: 24, yellow: 50 } },
    { stock: { blue: 20, purple: 24.5, yellow: 50 } },
    { stock: { blue: 20, purple: 24 } },
    { outcome: "success" },
  ])("rejects corrupted or non-input data rather than normalizing it: %j", (change) => {
    const storage = memoryStorage();
    storage.setItem(
      key,
      JSON.stringify({
        schema: 1,
        revision: "legacy-input-v1",
        savedAt: now,
        url,
        input: { ...input, ...change },
      }),
    );
    expect(consumeLegacyInputRecovery(storage, url, now)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });
  it("fails closed on malformed JSON and unavailable session storage", () => {
    const storage = memoryStorage();
    storage.setItem(key, "{not-json");
    expect(consumeLegacyInputRecovery(storage, url, now)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveLegacyInputRecovery(input, blocked, url, now)).toBe(false);
    expect(consumeLegacyInputRecovery(blocked, url, now)).toBeNull();
  });
  it("does not authorize reload unless the exact snapshot can be read back", () => {
    const discarded = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    expect(saveLegacyInputRecovery(input, discarded, url, now)).toBe(false);
  });
  it("projects trusted inputs without serializing extra outputs or event context", () => {
    const storage = memoryStorage();
    const richer = {
      ...input,
      result: { type: "recommendation" },
      pendingStatsEvent: { outcome: "success" },
      stock: { ...input.stock, forecast: 10 },
    };
    expect(saveLegacyInputRecovery(richer, storage, url, now)).toBe(true);
    expect(JSON.parse(storage.getItem(key) ?? "").input).toEqual(input);
    expect(consumeLegacyInputRecovery(storage, url, now)).toEqual(input);
  });
});
