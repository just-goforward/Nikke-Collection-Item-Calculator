import { describe, expect, it } from "vitest";
import { makeRustCoreExports as makeExports } from "./rustCore.test-helper";
import { createRustMinEfSolver } from "./rustMinEfCore";
import { normalizeRustProductInput } from "./rustProductInput";
import {
  clearLastMinEfPolicy,
  minEfPolicyCacheKey,
  readLastMinEfPolicy,
  rememberLastMinEfPolicy,
} from "./rustProductSolverCache";

describe("rust product solver cache", () => {
  it("keeps only the last matching min-E[f] policy cache entry", () => {
    clearLastMinEfPolicy();
    const solver = createRustMinEfSolver(makeExports());
    const policy = solver.solveRootWithCandidates(
      { grade: "SR", level: 1, exp: 0 },
      { blue: 10, purple: 10, yellow: 10 },
    );
    const key = minEfPolicyCacheKey({
      horizonFactor: 0.75,
      input: normalizeRustProductInput({
        start: { grade: "SR", level: 1, exp: 0 },
        stock: { blue: 10, purple: 10, yellow: 10 },
      }),
      memoTier: 21,
      normPower: 3,
      tolerance: 0,
    });

    expect(key).toMatch(/^supply-2026-08-21-v1\|/);
    rememberLastMinEfPolicy(key, policy);

    expect(readLastMinEfPolicy(key)).toBe(policy);
    expect(readLastMinEfPolicy(`${key}|different`)).toBeNull();

    clearLastMinEfPolicy();
    expect(readLastMinEfPolicy(key)).toBeNull();
  });
});
