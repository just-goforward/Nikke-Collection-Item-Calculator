import { describe, expect, it, vi } from "vitest";

import { createRustPhase2Solver } from "./rustCore";
import { makeRustCoreExports as makeExports } from "./rustCore.test-helper";

describe("rust phase2 core wrapper", () => {
  it("wraps phase2 solveCore results", () => {
    const solver = createRustPhase2Solver(makeExports());

    expect(
      solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 20, yellow: 30 }),
    ).toEqual({
      firstAction: "yellow",
      successProbability: 0.8,
      maxSuccessProbability: 0.82,
      vector: { blue: 11, purple: 22, yellow: 33 },
      states: 1234,
    });
  });

  it("throws on phase2 status before reading result accessors", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn(() => 2),
      resAction: vi.fn(() => {
        throw new Error("phase2 accessor should not be read");
      }),
    });
    const solver = createRustPhase2Solver(exports);

    expect(() =>
      solver.solveRoot({ grade: "SR", level: 1, exp: 0 }, { blue: 10, purple: 10, yellow: 10 }),
    ).toThrow("memo_full");
    expect(exports.resAction).not.toHaveBeenCalled();
  });

  it("treats phase2 depleted sentinel as a normal no-action result", () => {
    const solver = createRustPhase2Solver(
      makeExports({
        solveCore: vi.fn(() => -3),
        resAction: vi.fn(() => -1),
        resSuccessProb: vi.fn(() => 0),
        resMaxSuccessProb: vi.fn(() => 0),
        resVecB: vi.fn(() => 0),
        resVecP: vi.fn(() => 0),
        resVecY: vi.fn(() => 0),
      }),
    );

    expect(
      solver.solveRoot({ grade: "R", level: 0, exp: 0 }, { blue: 0, purple: 0, yellow: 0 }),
    ).toEqual({
      firstAction: null,
      successProbability: 0,
      maxSuccessProbability: 0,
      vector: { blue: 0, purple: 0, yellow: 0 },
      states: 1234,
    });
  });

  it("reads exact phase2 root candidates after solving", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    expect(
      solver.rootCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 20, yellow: 30 },
      ),
    ).toEqual([
      {
        firstAction: "blue",
        successProbability: 0.9,
        maxSuccessProbability: 0.9,
        probabilityGap: 0,
        vector: { blue: 10, purple: 20, yellow: 30 },
        resourceCost: 0.1,
        eligible: true,
      },
      {
        firstAction: "yellow",
        successProbability: 0.895,
        maxSuccessProbability: 0.9,
        probabilityGap: 0.0050000000000000044,
        vector: { blue: 12, purple: 22, yellow: 32 },
        resourceCost: 2.1,
        eligible: false,
      },
    ]);
    expect(exports.solveCore).toHaveBeenCalled();
  });

  it("does not read root candidates when phase2 candidate solve fails", () => {
    const exports = makeExports({
      getSolveStatus: vi.fn(() => 2),
      rootCandidateValid: vi.fn(() => {
        throw new Error("candidate getter should not be read");
      }),
    });
    const solver = createRustPhase2Solver(exports);

    expect(() =>
      solver.rootCandidates(
        { grade: "SR", level: 1, exp: 0 },
        { blue: 10, purple: 10, yellow: 10 },
      ),
    ).toThrow("memo_full");
    expect(exports.rootCandidateValid).not.toHaveBeenCalled();
  });

  it("wraps phase2 first-action E[f] simulation", () => {
    const exports = makeExports();
    const solver = createRustPhase2Solver(exports);

    expect(
      solver.estimateExpectedCostAfterFirstAction(
        { grade: "SR", level: 1, exp: 200 },
        { blue: 25, purple: 35, yellow: 45 },
        "purple",
        1200,
        20260509,
      ),
    ).toEqual({ expectedCost: 0.456, completionRate: 0.99 });

    expect(exports.simulateExpectedFAfterFirstAction).toHaveBeenCalledWith(
      512,
      2,
      3,
      4,
      25,
      35,
      45,
      0.75,
      3,
      0,
      1200,
      20260509,
      1,
    );
  });
});
