import { fromWire, type Q } from "../../shared/certifiedRational";
import { assertCertifiedRuntimeSupplySnapshot } from "../../shared/certifiedSupply";
import { CertifiedLimit, WorkBudget } from "./budget";
import { CAPS, encode } from "./game";
import type { CertifiedCurrent, CertifiedInput, CertifiedMinimumWaitProbe, Triple } from "./types";
import { validate } from "./validation";
import { WasmKernel } from "./wasmBackend";

/** Diagnostic-only JSON protocol; no oracle or expected-result data is imported.
 * Uses the baseline first exact-optimal kit and its maximal optimal batch.
 * Full per-day supports are reported uncapped; finite-game P lookups report caps.
 */
export function probeCertifiedMinimumWait(
  module: WebAssembly.Module,
  input: CertifiedInput,
): CertifiedMinimumWaitProbe {
  const started = performance.now();
  const budget = new WorkBudget({}, started);
  let kernel: WasmKernel | null = null;
  let current: CertifiedCurrent | null = null;
  let caps: Triple = [0, 0, 0];
  try {
    assertCertifiedRuntimeSupplySnapshot(input.snapshot);
    const priors = validate(input, budget.check);
    budget.reserve(JSON.stringify(input).length * 2);
    const sid = encode(input.grade, input.level, input.exp);
    const selectedCaps = CAPS[sid];
    if (!selectedCaps) throw new CertifiedLimit("invalid_state");
    caps = selectedCaps;
    kernel = new WasmKernel(module, budget);
    const pricing = kernel.prepare(input, sid, priors);
    kernel.initialize(pricing.weights.map(fromWire) as [Q, Q, Q]);
    current = kernel.current(sid, input);
    return kernel.minimumWaitProbe(sid, input, current);
  } catch (error) {
    return {
      version: "certified-minimum-wait-probe-v1",
      status: "NOTRUN",
      recommendation: { kit: current?.kit ?? null, uses: current?.uses ?? 0 },
      label: "unknown",
      certificateApplies: false,
      certificateShortcutUsed: false,
      classifierCaps: caps,
      supportUnitsCapped: false,
      reason: error instanceof Error ? error.message : "minimum_wait_probe_failed",
      complete: false,
      perDay: [],
    };
  } finally {
    kernel?.dispose();
  }
}
