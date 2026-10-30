// Test-only replacement for solver execution/loading; production boundary code is unchanged.
import assert from "node:assert/strict";
import { workerData } from "node:worker_threads";
import { CertifiedLimit, WorkBudget, reserveTargetPayload, targetBudgetView } from "../certified/budget.ts";

export async function loadCertifiedWasm() {
  return WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
}

export function solveCertifiedWasm(_module, _input, options) {
  const budget = new WorkBudget(options, performance.now());
  const liveCharge = 4096;
  budget.reserve(liveCharge);
  let retained = liveCharge;
  const view = targetBudgetView(budget);
  const handle = {
    check() {
      view.check();
      assert.equal(budget.managedPayloadBytes >= liveCharge, true,
        "binding cleanup must never release the pre-existing live charge");
    },
    reserve: view.reserve,
    release(bytes) {
      view.release(bytes);
      assert.equal(budget.managedPayloadBytes, retained,
        "scoped binding release must restore exactly the retained allocation");
    },
  };
  options.onTargetBudget(handle);
  options.onCurrent(structuredClone(workerData.output));
  assert.equal(budget.managedPayloadBytes, liveCharge);

  // Exercise core's actual pre-allocation transaction, not a fixture rollback.
  // The same captured WorkBudget must remain usable by final worker binding.
  const rejectedCharge = budget.maxManagedPayloadBytes;
  assert.throws(() => reserveTargetPayload(budget, rejectedCharge),
    error => error instanceof CertifiedLimit && error.reason === "managed_payload_ceiling");
  assert.equal(budget.managedPayloadBytes, liveCharge);

  const result = structuredClone(workerData.output);
  result.status = "partial";
  result.refusal = { phase: "waiting", reason: "managed_payload_ceiling" };
  result.target.reason = "managed_payload_ceiling";
  if (workerData.mode === "binding-memory") {
    budget.reserve(budget.maxManagedPayloadBytes - liveCharge);
    retained = budget.maxManagedPayloadBytes;
  }
  if (workerData.mode === "invalid-binding") result.target.minimumDays = 99;
  return result;
}
