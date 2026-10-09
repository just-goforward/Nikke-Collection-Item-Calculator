import { fromWire, type Q, q, sub, toWire } from "../../shared/certifiedRational";
import { isCertifiedEventClaimable } from "../../shared/certifiedSupply";
import { CertifiedLimit, WorkBudget } from "./budget";
import { waitingBase } from "./events";
import { encode } from "./game";
import { createOutput, updateDiagnostics } from "./output";
import type { CertifiedInput, CertifiedOptions, CertifiedOutput } from "./types";
import { validate } from "./validation";
import { WasmKernel } from "./wasmBackend";

function applyTrapWaitingBounds(
  output: CertifiedOutput,
  kernel: WasmKernel | null,
  phase: NonNullable<CertifiedOutput["refusal"]>["phase"],
): void {
  if (phase !== "waiting" || !kernel?.hasFailed || !output.current) return;
  // A trap loses all unpublished Rust progress. Only D0 is established;
  // nonnegative inventory coupling still gives this conservative H56 bound.
  const lower = output.current.value.successP;
  output.waiting.evaluatedDays = [0];
  output.waiting.successProbabilityInterval = { lower, upper: toWire(q(1)) };
  output.waiting.successImprovementUpperBound = toWire(sub(q(1), fromWire(lower)));
  output.waiting.evidence = [
    "PH_lower_bound_from_exact_current_P_and_inventory_coupling",
    "UNKNOWN_is_not_equality_or_false",
  ];
}

/** Host owns validation, trust and calendar normalization. Pricing, physical
 * laws, current policy and H56 certificates are computed entirely in Rust. */
export function solveCertifiedWasm(
  module: WebAssembly.Module,
  input: CertifiedInput,
  options: CertifiedOptions = {},
): CertifiedOutput {
  const started = performance.now();
  let budget: WorkBudget | null = null;
  let kernel: WasmKernel | null = null;
  let phase: NonNullable<CertifiedOutput["refusal"]>["phase"] = "input";
  const output = createOutput(input);
  output.provenance.solverVersion = "certified-exact-rust-wasm-v1";
  const diagnostics = () => {
    updateDiagnostics(output, started, budget);
    output.diagnostics.wasmMemoryBytes = kernel?.memoryBytes ?? 0;
    output.diagnostics.managedPayloadDefinition =
      "owned host numerical payload plus peak Rust heap including transient allocations; WASM linear memory separately measured";
    output.diagnostics.unmeasuredMemory = [
      "host JS allocator metadata and compiler cache",
      "Worker native stack",
      "WASM compiled code",
      "host supply-law transient work tables",
    ];
  };
  try {
    budget = new WorkBudget(options, started);
    budget.check();
    const priors = validate(input, budget.check);
    budget.reserve(JSON.stringify(input).length * 2);
    kernel = new WasmKernel(module, budget);
    phase = "pricing";
    const sid = encode(input.grade, input.level, input.exp);
    const pricing = kernel.prepare(input, sid, priors);
    const weights = pricing.weights.map(fromWire) as [Q, Q, Q];
    output.pricing = pricing;
    phase = "current";
    kernel.initialize(weights);
    output.current = kernel.current(sid, input);
    output.status = "partial";
    output.waiting = { ...waitingBase("unresolved", "waiting_in_progress"), bestDayRange: [0, 56] };
    diagnostics();
    options.onCurrent?.(structuredClone(output));
    phase = "waiting";
    const received = new Set(input.receivedEventIds ?? []);
    const claimable = input.snapshot.events.filter(
      (event) =>
        isCertifiedEventClaimable(input.snapshot, event, input.asOf) && !received.has(event.id),
    );
    if (claimable.length) {
      output.claimNotice = {
        eventIds: claimable.map((event) => event.id),
        message: "Claim the currently available rewards, update stock, then calculate again.",
      };
      output.waiting = waitingBase("claim_required", "current_claimable_unreceived");
    } else if (input.computeWaiting === false) output.waiting = waitingBase("not_requested", null);
    else output.waiting = kernel.waiting(sid, input);
    if (input.snapshot.sourceStatus !== "healthy")
      output.waiting.evidence = [
        ...output.waiting.evidence,
        "modeled_forecast_source_uncertain_no_automatic_delay",
      ];
    output.status = output.waiting.status === "unresolved" ? "partial" : "completed";
    if (output.waiting.status === "unresolved")
      output.refusal = { reason: output.waiting.reason ?? "waiting_unresolved", phase: "waiting" };
  } catch (error) {
    let reason = "internal_solver_error";
    if (error instanceof CertifiedLimit) reason = error.reason;
    else if (error instanceof Error) reason = error.message;
    output.refusal = { reason, phase };
    output.status = output.current ? "partial" : "refused";
    output.waiting = {
      ...waitingBase("unresolved", reason),
      bestDayRange: output.current ? [0, 56] : null,
    };
    applyTrapWaitingBounds(output, kernel, phase);
  }
  diagnostics();
  kernel?.dispose();
  return output;
}
