import { REQUIRED_EXP } from "../../shared/game";
import type { CertifiedRuntimeOutput } from "../certifiedRuntime/outputBinding";
import { message } from "../i18n/locale";
import type { SolverInput } from "../types";
import type { DetailView, ResultView } from "../ui-types";
import { formatReadablePercent } from "../view-models/detailMetrics";
import { makeOutcomePreview } from "../view-models/outcomePresentation";
import { buildRecommendedRunForKit } from "../wasm/rustProductView";
import type { ServiceCertifiedResult, ServiceCertifiedSolveOutcome } from "./serviceCertifiedTypes";

export function withoutRecommendedWait(view: DetailView): DetailView {
  if (view.type !== "metrics" || view.recommendedWaitDays === undefined) return view;
  const { recommendedWaitDays: _removed, ...rest } = view;
  return rest;
}

/** Called only with output already validated by the production certified client. */
export function projectServiceCertifiedResult(
  input: SolverInput,
  output: CertifiedRuntimeOutput,
  final: boolean,
): ServiceCertifiedSolveOutcome {
  const current = output.current;
  let action: ServiceCertifiedResult["action"] = null;
  if (
    output.status !== "refused" &&
    !output.claimNotice &&
    output.waiting.status !== "claim_required" &&
    current?.status === "use_certified"
  ) {
    const kit = current.kit;
    const uses = current.uses;
    if (
      !kit || !Number.isInteger(uses) || uses < 1 ||
      current.pieces !== uses * 10 || input.stock[kit] < current.pieces
    ) throw new Error("service_certified_action_contract");
    // Physical inventory only. Never call the legacy normalizer, caps or action lookup.
    const stockUses = {
      blue: Math.floor(input.stock.blue / 10),
      purple: Math.floor(input.stock.purple / 10),
      yellow: Math.floor(input.stock.yellow / 10),
    };
    const run = buildRecommendedRunForKit(
      { ...input, stockUses, actualStockUses: stockUses, requiredExp: REQUIRED_EXP },
      () => kit,
      kit,
      uses,
    );
    if (!run || run.count !== uses) throw new Error("service_certified_run_count_mismatch");
    action = { kit, run };
  }
  return {
    kind: "service-certified",
    result: { input, certified: { output, final, action } },
  };
}

export function serviceCertifiedWaitDays(value: ServiceCertifiedResult): number | undefined {
  const { output, final } = value;
  const stable = output.stableRecommendation;
  if (
    !final || output.status === "refused" || output.refusal || output.claimNotice ||
    output.waiting.status === "claim_required" ||
    stable?.selection.status !== "WAIT" || stable.guidance.status !== "WAIT"
  ) return undefined;
  const day = stable.selection.day;
  return Number.isInteger(day) && day >= 1 && day <= 14 && stable.guidance.day === day
    ? day : undefined;
}

export function serviceCertifiedViews(
  input: SolverInput,
  value: ServiceCertifiedResult,
): { result: ResultView; detail: DetailView } {
  const { output, action } = value;
  if (input.start.grade === "SR" && input.start.level === 15) {
    return {
      result: { type: "callout", reason: "final_target", message: message("result.complete") },
      detail: { type: "empty", message: message("result.complete") },
    };
  }
  if (output.claimNotice || output.waiting.status === "claim_required") {
    const explanation = message("result.certifiedClaimRequired");
    return {
      result: { type: "error", reason: "certified_claim_required", message: explanation },
      detail: { type: "empty", message: explanation },
    };
  }
  if (input.start.grade === "R" && input.start.level === 15) {
    return {
      result: { type: "convertRecommendation", reason: "r15_conversion" },
      detail: { type: "empty", message: message("result.convertAvailable") },
    };
  }
  if (output.status === "refused" || !output.current) {
    const explanation = message("result.solverError");
    return {
      result: { type: "error", reason: "solver_failure", message: explanation },
      detail: { type: "empty", message: explanation },
    };
  }
  if (output.current.status === "preserve") {
    const explanation = message("result.certifiedPreserve");
    const day = serviceCertifiedWaitDays(value);
    return {
      result: { type: "callout", reason: "certified_preserve", message: explanation },
      detail: {
        type: "metrics",
        successProbability: formatReadablePercent(output.current.value.display.successP, 2),
        greatSuccessProbability: null,
        candidates: [],
        monteCarloRuns: 0,
        solverLabel: "Certified Rust/WASM",
        ...(day === undefined ? {} : { recommendedWaitDays: day }),
      },
    };
  }
  if (!action) throw new Error("service_certified_current_contract");
  const day = serviceCertifiedWaitDays(value);
  return {
    result: {
      type: "recommendation",
      kit: action.kit,
      count: action.run.count,
      failPreview: makeOutcomePreview(input.start, action.run.fail),
      successPreview: makeOutcomePreview(input.start, action.run.success),
    },
    detail: {
      type: "metrics",
      successProbability: formatReadablePercent(output.current.value.display.successP, 2),
      // Existing physical batch helper's floating-point display, not a new exact certificate.
      greatSuccessProbability: formatReadablePercent(action.run.greatSuccessProbability!, 1),
      candidates: [],
      monteCarloRuns: 0,
      solverLabel: "Certified Rust/WASM",
      ...(day === undefined ? {} : { recommendedWaitDays: day }),
    },
  };
}
