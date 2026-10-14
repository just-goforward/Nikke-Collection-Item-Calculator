import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { q, toWire } from "../../shared/certifiedRational";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { interruptedCertifiedWaiting } from "../certifiedRuntime/partial";
import { assertMinimumWaitBinding, assertMinimumWaitTie, minimumWaitBase } from "./minimumWait";
import type { CertifiedInput, CertifiedMinimumWait, CertifiedOutput, Triple } from "./types";
import { loadCertifiedWasm } from "./wasmBackend";
import { solveCertifiedWasm } from "./wasmSolver";

const AS_OF = "2026-10-13T04:38:49.399Z";
let module: WebAssembly.Module;
beforeAll(async () => {
  module = await loadCertifiedWasm(() => readFile("public/certified_solver.wasm"));
});
function request(level = 14, exp = 2900, stock: Triple = [19, 0, 0]): CertifiedInput {
  const snapshot = buildCertifiedSupplySnapshot({
    asOf: AS_OF,
    revision: "minimum-wait-unit",
    sourceHash: "a".repeat(64),
    soloPeriods: [],
    collaborationPeriods: [],
  });
  return {
    grade: "SR",
    level,
    exp,
    stock,
    asOf: AS_OF,
    snapshot,
    receivedEventIds: snapshot.events
      .filter((event) => Date.parse(event.at) <= Date.parse(AS_OF))
      .map((event) => event.id),
    computeWaiting: false,
    computeMinimumWait: true,
    batchLimit: 10,
  };
}

describe("versioned batch-bound minimum-wait stage", () => {
  it("publishes current first and its label before the separate H56 stage", () => {
    const partials: CertifiedOutput[] = [];
    const result = solveCertifiedWasm(module, request(), {
      onCurrent: (value) => partials.push(value),
    });
    expect(partials).toHaveLength(2);
    expect(partials[0]?.minimumWait?.status).toBe("unknown");
    expect(partials[1]?.minimumWait?.status).toBe("beyond_horizon");
    expect(partials[1]?.waiting.reason).toBe("waiting_in_progress");
    expect(result.minimumWait).toMatchObject({
      version: "certified-minimum-wait-v1",
      status: "beyond_horizon",
      kit: "blue",
      uses: 1,
      pieces: 10,
      thresholdDays: toWire(q(1)),
      horizonDays: 7,
      minimumDays: null,
    });
    expect(result.waiting.status).toBe("not_requested");
    assertMinimumWaitBinding(result.minimumWait, result.current);
  });

  it("keeps unconfirmed coverage distinct from a proved out-of-range result", () => {
    const input = request(10, 0, [20, 10, 10]);
    input.snapshot = {
      ...input.snapshot,
      coverage: {
        ...input.snapshot.coverage,
        future: { ...input.snapshot.coverage.future, complete: false, missing: ["test_gap"] },
      },
    };
    const result = solveCertifiedWasm(module, input);
    expect(result.current).not.toBeNull();
    expect(result.minimumWait).toMatchObject({
      status: "unknown",
      minimumDays: null,
      reason: "minimum_wait_future_coverage_incomplete",
    });
  });

  it("returns UNKNOWN on support guard exhaustion, never 7+", () => {
    const input = request(10, 0, [20, 10, 10]);
    const rule = input.snapshot.rules[0];
    if (!rule) throw new Error("missing fixture rule");
    input.snapshot = {
      ...input.snapshot,
      laws: [
        ...input.snapshot.laws,
        {
          id: "two",
          kind: "finite",
          modelVersion: "test",
          outcomes: [
            { pieces: [0, 0, 0], mass: toWire(q(1, 2)) },
            { pieces: [10, 0, 0], mass: toWire(q(1, 2)) },
          ],
        },
      ],
      events: [
        {
          id: "dispatch:2026-10-14",
          gameDate: "2026-10-14",
          at: "2026-10-14T08:00:00Z",
          kind: "dispatch",
          status: "confirmed",
          ruleId: rule.id,
          refs: [{ lawId: "two", count: 1 }],
        },
      ],
    };
    const result = solveCertifiedWasm(module, input, { maxSupportPoints: 1 });
    expect(result.current?.kit).toBe("yellow");
    expect(result.minimumWait).toMatchObject({
      status: "unknown",
      minimumDays: null,
      reason: "exact_support_limit",
    });
  });

  it("retains a published certificate when later waiting is interrupted", () => {
    const result = solveCertifiedWasm(module, request());
    const partial = interruptedCertifiedWaiting(result, "deadline");
    expect(partial.minimumWait).toEqual(result.minimumWait);
    expect(partial.waiting.status).toBe("unresolved");
    const pending = {
      ...result,
      minimumWait: minimumWaitBase(result.current, "unknown", "minimum_wait_in_progress"),
    };
    expect(interruptedCertifiedWaiting(pending, "aborted").minimumWait).toMatchObject({
      status: "unknown",
      reason: "worker_abort",
    });
  });

  it("rejects stale kit/batch bindings and a single-use certificate relabeled as a larger batch", () => {
    const result = solveCertifiedWasm(module, request());
    const current = result.current;
    const proof = result.minimumWait;
    if (!current || !proof) throw new Error("missing proof");
    for (const patch of [
      { kit: "yellow" },
      { uses: 2 },
      { pieces: 20 },
      { horizonDays: 56 },
      { thresholdDays: toWire(q(2)) },
      { earliestPossibleDay: 1 },
    ])
      expect(() => assertMinimumWaitBinding({ ...proof, ...patch }, current)).toThrow();
    const larger = { ...current, uses: 3, pieces: 30 };
    expect(() => assertMinimumWaitBinding({ ...proof, uses: 3, pieces: 30 }, larger)).toThrow();
    const unknown: CertifiedMinimumWait = {
      ...minimumWaitBase(current, "unknown", "request_budget_exhausted"),
      earliestPossibleDay: 3,
      evaluatedDays: [1, 2],
      mixedDailyRate: proof.mixedDailyRate,
    };
    expect(() => assertMinimumWaitBinding(unknown, current)).not.toThrow();
    expect(() => assertMinimumWaitBinding({ ...unknown, minimumDays: 3 }, current)).toThrow();
  });

  it("does not admit a tie based on P alone or on approximate B/C equality", () => {
    const input = request();
    const current = solveCertifiedWasm(module, input).current;
    if (!current) throw new Error("missing current");
    expect(() => assertMinimumWaitTie(current, current, input)).not.toThrow();
    for (const key of ["weightedExpectedConsumptionB", "expectedTotalConsumptionC"] as const) {
      const value = current.value[key];
      const changed = {
        ...current,
        value: {
          ...current.value,
          [key]: { ...value, numerator: String(BigInt(value.numerator) + 1n) },
        },
      };
      expect(() => assertMinimumWaitTie(current, changed, input)).toThrow();
    }
  });
});
