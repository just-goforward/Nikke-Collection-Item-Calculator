import { describe, expect, it } from "vitest";

import { COMPACT_FRONTIER_WGSL, hashCapacityForInput } from "./compact-frontier-kernel";

describe("WebGPU compact frontier kernel contract", () => {
  it("keeps hash load below one half for six successors per input", () => {
    expect(hashCapacityForInput(1)).toBe(16);
    expect(hashCapacityForInput(100)).toBeGreaterThanOrEqual(1_200);
    expect(hashCapacityForInput(100) & (hashCapacityForInput(100) - 1)).toBe(0);
  });

  it("uses integer atomics and no floating point value channel", () => {
    expect(COMPACT_FRONTIER_WGSL).toContain("array<atomic<u32>>");
    expect(COMPACT_FRONTIER_WGSL).toContain("atomicCompareExchangeWeak");
    expect(COMPACT_FRONTIER_WGSL).not.toMatch(/\bf(?:16|32|64)\b/u);
  });
});
