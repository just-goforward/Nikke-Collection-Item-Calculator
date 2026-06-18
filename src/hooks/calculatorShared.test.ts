import { describe, expect, it } from "vitest";

import { makeSolverDiagnosticEvent } from "./calculatorDiagnostics";

describe("makeSolverDiagnosticEvent", () => {
  it("uses solver version and phase from result stats", () => {
    const result = {
      possible: true,
      input: {
        start: { grade: "SR", level: 10, exp: 0 },
        stock: { blue: 100, purple: 100, yellow: 100 },
      },
      best: {
        firstAction: "yellow",
        firstProbability: 0.45,
        run: {
          count: 1,
          success: { grade: "SR", level: 15, exp: 0 },
          fail: { grade: "SR", level: 11, exp: 0 },
        },
        vector: { blue: 0, purple: 0, yellow: 10 },
        totalKits: 10,
        successProbability: 0.5,
        maxSuccessProbability: 0.5,
        probabilityGap: 0,
        resourceCost: 0.1,
        legacySupplyCost: 0.2,
      },
      candidateCount: 1,
      route: [],
      monteCarlo: null,
      stats: {
        solverVersion: "phase2_availability_h075_tau0_p3_rust_rerank_staging",
        solverPhase: "phase2-rerank",
        solverBackend: "rust-phase2-rerank",
        fallbackFrom: "rust-min-ef",
        fallbackReason: "memo_full",
        solveMs: 123,
      },
      topCandidates: [],
    } as Parameters<typeof makeSolverDiagnosticEvent>[0];

    expect(makeSolverDiagnosticEvent(result)).toMatchObject({
      diagnosticVersion: 4,
      solverVersion: "phase2_availability_h075_tau0_p3_rust_rerank_staging",
      solverPhase: "phase2-rerank",
      solverBackend: "rust-phase2-rerank",
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      nodeCountBucket: "0",
      solveMsBucket: "100_250",
      stockBuckets: { blue: "100_149", purple: "100_149", yellow: "100_149" },
    });
  });
});
