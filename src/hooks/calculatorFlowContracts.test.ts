import { describe, expect, it } from "vitest";

import type { ResultView } from "../ui-types";
import type { SolverResult } from "./calculatorShared";
import { isMaxLevelGeneratedResult } from "./calculatorStaleResult";
import { validationBackendFromResult } from "./calculatorValidationFlow";
import { canApplyConversion } from "./outcomeConvertAction";

describe("validation backend contract", () => {
  it("reuses the backend that produced the displayed result", () => {
    const result = {
      possible: true,
      stats: { solverBackend: "rust-phase2" },
    } satisfies SolverResult;

    expect(validationBackendFromResult(result)).toBe("rust-phase2");
  });

  it("does not forward historical or unknown backend labels", () => {
    const result = {
      possible: true,
      stats: { solverBackend: "rust-phase2-rerank" },
    } satisfies SolverResult;

    expect(validationBackendFromResult(result)).toBeUndefined();
  });
});

describe("R15 conversion contract", () => {
  it("recognizes a conversion-capable outcome as a generated max-level result", () => {
    const view = {
      type: "outcome",
      kit: "blue",
      count: 1,
      outcome: "success",
      state: { grade: "R", level: 15, exp: 0 },
      stockMessage: { key: "result.calculateChanged" },
      canConvert: true,
    } as ResultView;

    expect(isMaxLevelGeneratedResult(view)).toBe(true);
  });

  it("allows conversion only from the current R15 state", () => {
    expect(canApplyConversion({ grade: "R", level: 15, exp: 0 })).toBe(true);
    expect(canApplyConversion({ grade: "R", level: 14, exp: 0 })).toBe(false);
    expect(canApplyConversion({ grade: "SR", level: 15, exp: 0 })).toBe(false);
  });
});
