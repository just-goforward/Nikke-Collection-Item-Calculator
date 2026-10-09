import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kit } from "../src/types";
import { createPrioritizedFallbackLadderSession } from "./prioritized-policy-ladder";
import { createRecordedCvarFallbackLadderSession } from "./recorded-cvar-ladder";
import { createSolverPortfolioLadderSession } from "./solver-portfolio-routing";
import { createSparseFallbackLadderSession } from "./sparse-policy-ladder";

const mocks = vi.hoisted(() => ({
  minEf: {
    configureMemoTier: vi.fn(),
    solveRootWithCandidates: vi.fn(),
    releaseMemo: vi.fn(),
  },
}));
vi.mock("../src/wasm/rustLoader", () => ({
  rustCoreExportsFromInstance: () => ({}),
}));
vi.mock("../src/wasm/rustMinEfCore", () => ({
  createRustMinEfSolver: () => mocks.minEf,
}));
vi.mock("../src/wasm/rustPhase2Core", () => ({
  createRustPhase2Solver: () => ({ configureMemoTier: vi.fn(), releaseMemo: vi.fn() }),
}));

const instance = {} as WebAssembly.Instance;
const ladders = [
  ["recorded", () => createRecordedCvarFallbackLadderSession(instance, instance, instance)],
  ["prioritized", () => createPrioritizedFallbackLadderSession(instance, instance)],
  ["sparse", () => createSparseFallbackLadderSession(instance, instance)],
  [
    "portfolio",
    () =>
      createSolverPortfolioLadderSession("baseline", {
        minEfTier21: instance,
        phase2: instance,
      }),
  ],
] as const;
const input = {
  start: { grade: "SR" as const, level: 14, exp: 0 },
  stock: { blue: 29, purple: 9, yellow: 9 },
  strategy: "supply" as const,
};

afterEach(() => vi.clearAllMocks());

describe.each(ladders)("%s ladder min-E[f] decision", (_name, session) => {
  it.each([null, "blue"] as const)("preserves the first-action contract for %s", (firstAction) => {
    const policy = {
      root: {
        firstAction,
        maxSuccessProbability: 0.9,
        successProbability: 0.8,
        expectedCost: 1,
        vector: { blue: 0, purple: 0, yellow: 0 },
      },
      nodeCount: 1,
      actionAt(): Kit {
        expect(this).toBe(policy);
        return "blue";
      },
    };
    mocks.minEf.solveRootWithCandidates.mockReturnValue(policy);
    const result = session().policySolver(input);
    if (firstAction === null) {
      expect(result).toEqual({ possible: false, best: null });
    } else {
      expect(result).toEqual({
        possible: true,
        best: { firstAction: "blue", probabilityGap: 0.9 - 0.8, run: { count: 2 } },
      });
      expect(Object.keys(result.best ?? {})).toEqual(["firstAction", "probabilityGap", "run"]);
    }
    expect(mocks.minEf.solveRootWithCandidates).toHaveBeenCalledExactlyOnceWith(
      input.start,
      input.stock,
      0.75,
      3,
      0,
    );
  });

  it("preserves ordinary failures instead of invoking the fallback", () => {
    const error = new Error("min-E[f] failed");
    mocks.minEf.solveRootWithCandidates.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => session().policySolver(input)).toThrow(error);
  });
});
