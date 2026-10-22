import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { solveCertified } from "../../../src/certified/solver.ts";
import type { CertifiedInput } from "../../../src/certified/types.ts";
import { loadCertifiedWasm } from "../../../src/certified/wasmBackend.ts";
import { solveCertifiedWasm } from "../../../src/certified/wasmSolver.ts";
import type { calculatePanel } from "./calculate.ts";

/** Current-stock proof only: neither backend is used to derive expected values. */
export async function verifyEngines(
  snapshot: CertifiedSupplySnapshot,
  cases: ReturnType<typeof calculatePanel>,
) {
  const module = await loadCertifiedWasm(async () => readFileSync("public/certified_solver.wasm"));
  for (const row of cases) {
    const { cohortWeights: _stored, ...state } = row.input;
    const input: CertifiedInput = {
      ...state,
      snapshot,
      computeWaiting: false,
      computeMinimumWait: false,
    };
    for (const output of [solveCertified(input), solveCertifiedWasm(module, input)]) {
      assert.equal(output.status, "completed", `${row.id}: ${JSON.stringify(output.refusal)}`);
      assert.equal(output.refusal, null);
      assert.deepEqual(output.pricing?.cohortWeights, row.input.cohortWeights);
      assert.deepEqual(output.pricing?.recurringRate, row.expected.rates, `${row.id}: rates`);
      assert.deepEqual(output.pricing?.weights, row.expected.prices, `${row.id}: prices`);
      const value = output.current?.value;
      assert.deepEqual(
        {
          P: value?.successP,
          B: value?.weightedExpectedConsumptionB,
          C: value?.expectedTotalConsumptionC,
          consumed: value?.expectedConsumed,
        },
        {
          P: row.expected.P,
          B: row.expected.B,
          C: row.expected.C,
          consumed: row.expected.consumed,
        },
        row.id,
      );
      const action = row.expected.action;
      assert.equal(output.current?.kit, action === "STOP" || action === "DONE" ? null : action);
      assert.equal(
        output.current?.status,
        action === "STOP" ? "preserve" : action === "DONE" ? "complete" : "use_certified",
      );
      const mask = row.expected.ties.reduce(
        (bits, kit) =>
          bits | (kit === "blue" ? 1 : kit === "purple" ? 2 : kit === "yellow" ? 4 : 0),
        0,
      );
      assert.equal(output.current?.optimalActionMask, mask, `${row.id}: ties`);
    }
  }
  return cases.length;
}
