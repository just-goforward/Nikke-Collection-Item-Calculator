import { CertifiedLimit, WorkBudget } from "./budget";
import { currentView } from "./current";
import { waitingBase } from "./events";
import { encode } from "./game";
import { FiniteKernel } from "./kernel";
import { createOutput, updateDiagnostics } from "./output";
import { calculatePricing } from "./pricing";
import type { CertifiedInput, CertifiedOptions, CertifiedOutput } from "./types";
import { validate } from "./validation";
import { completeWaiting } from "./waitingResult";

/** Isolated staging entry. The repeated graph shares one total 15s deadline. */
export function solveCertified(
  input: CertifiedInput,
  options: CertifiedOptions = {},
): CertifiedOutput {
  const started = performance.now();
  let budget: WorkBudget | null = null;
  let phase: NonNullable<CertifiedOutput["refusal"]>["phase"] = "input";
  const output = createOutput(input);
  try {
    budget = new WorkBudget(options, started);
    budget.check();
    const priors = validate(input, budget.check);
    budget.reserve(JSON.stringify(input).length * 2);
    phase = "pricing";
    const { weights, pricing } = calculatePricing(input, priors, budget);
    output.pricing = pricing;
    budget.check();
    phase = "current";
    const sid = encode(input.grade, input.level, input.exp);
    const kernel = new FiniteKernel(weights, budget);
    const root = kernel.solve(sid, input.stock);
    output.current = currentView(sid, input, root, kernel);
    kernel.releaseTemporaryBounds();
    output.status = "partial";
    output.waiting = { ...waitingBase("unresolved", "waiting_in_progress"), bestDayRange: [0, 56] };
    updateDiagnostics(output, started, budget);
    options.onCurrent?.(structuredClone(output));
    phase = "waiting";
    completeWaiting(output, input, sid, root, kernel, priors);
    output.status = output.waiting.status === "unresolved" ? "partial" : "completed";
    if (output.waiting.status === "unresolved")
      output.refusal = { reason: output.waiting.reason ?? "waiting_unresolved", phase: "waiting" };
  } catch (error) {
    const reason =
      error instanceof CertifiedLimit
        ? error.reason
        : error instanceof Error
          ? error.message
          : "internal_solver_error";
    output.refusal = { reason, phase };
    output.status = output.current ? "partial" : "refused";
    output.waiting = {
      ...waitingBase("unresolved", reason),
      bestDayRange: output.current ? [0, 56] : null,
    };
  }
  updateDiagnostics(output, started, budget);
  return output;
}
