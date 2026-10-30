import { CertifiedLimit, evidenceBudgetView, reserveTargetPayload, WorkBudget } from "./budget";
import { completedEvidenceRequested } from "./completedEvidence";
import { currentView } from "./current";
import { waitingBase } from "./events";
import { encode } from "./game";
import { FiniteKernel } from "./kernel";
import { createOutput, updateDiagnostics } from "./output";
import { calculatePricing } from "./pricing";
import type { CertifiedInput, CertifiedOptions, CertifiedOutput } from "./types";
import { validate } from "./validation";
import { targetConfig } from "./target";
import { completeWaiting } from "./waitingResult";
import { validateStableRiskPolicy } from "../certifiedRecommendation/stablePolicy";

/** Independent JavaScript test oracle. The Worker uses wasmSolver, never this backend. */
export function solveCertified(
  input: CertifiedInput,
  options: CertifiedOptions = {},
): CertifiedOutput {
  const started = performance.now();
  let budget: WorkBudget | null = null;
  let phase: NonNullable<CertifiedOutput["refusal"]>["phase"] = "input";
  const output = createOutput(input);
  const needsEvidence = completedEvidenceRequested(input);
  try {
    budget = new WorkBudget(options, started);
    if (needsEvidence) {
      const view = evidenceBudgetView(budget);
      if (input.target !== undefined) options.onTargetBudget?.(view);
      options.onEvidenceBudget?.(view);
    }
    budget.check();
    const priors = validate(input, budget.check);
    const target = targetConfig(input);
    if (target) output.target = target;
    const inputBytes = JSON.stringify(input).length * 2;
    if (needsEvidence) reserveTargetPayload(budget, inputBytes);
    else budget.reserve(inputBytes);
    if (input.stableRecommendation !== undefined) {
      budget.check();
      validateStableRiskPolicy(input.stableRecommendation);
      budget.check();
    }
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
    output.waiting = { ...waitingBase("unresolved", "waiting_in_progress"), bestDayRange: [0, 14] };
    updateDiagnostics(output, started, budget);
    options.onCurrent?.(structuredClone(output));
    phase = "waiting";
    completeWaiting(output, input, sid, root, kernel, priors);
    output.status = output.waiting.status === "unresolved" ? "partial" : "completed";
    if (output.waiting.status === "unresolved")
      output.refusal = { reason: output.waiting.reason ?? "waiting_unresolved", phase: "waiting" };
  } catch (error) {
    let reason = "internal_solver_error";
    if (error instanceof CertifiedLimit) reason = error.reason;
    else if (error instanceof Error) reason = error.message;
    output.refusal = { reason, phase };
    delete output.completedEvidence;
    if (output.target)
      output.target = { ...output.target, status: output.claimNotice ? "claim_required" : "unresolved",
        reason, minimumDays: null, value: null, probabilities: [],
        earliestNotRuledOutDay: null, attainedByDay: null, completedThroughDay: null };
    output.status = output.current ? "partial" : "refused";
    output.waiting = {
      ...waitingBase("unresolved", reason),
      bestDayRange: output.current ? [0, 14] : null,
    };
  }
  updateDiagnostics(output, started, budget);
  return output;
}
