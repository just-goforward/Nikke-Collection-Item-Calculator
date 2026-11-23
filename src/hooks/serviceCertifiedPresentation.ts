import { adaptiveShell } from "../lib/rootCandidate";
import { REQUIRED_EXP } from "../../shared/game";
import { conditionalCurrent } from "../../shared/conditionalCurrent";
import type { ServiceH14Output } from "../serviceH14/types";
import { message } from "../i18n/locale";
import type { SolverInput } from "../types";
import type { DetailView, ResultView } from "../ui-types";
import { formatReadablePercent } from "../view-models/detailMetrics";
import { makeOutcomePreview } from "../view-models/outcomePresentation";
import { buildRecommendedRunForKit } from "../wasm/rustProductView";
import type { ServiceCertifiedResult, ServiceCertifiedSolveOutcome } from "./serviceCertifiedTypes";

export function previewStopMessage(stop: string | undefined, followUp = false) {
  if (stop === "resource" || stop === "memory")
    return message(followUp ? "result.previewFollowUpResourceLimit" : "result.previewResourceLimit");
  if (stop === "deadline") return message(followUp ? "result.previewFollowUpDeadline" : "result.previewDeadline");
  return message(stop === "worker" ? "result.solverError" : "result.previewInterrupted");
}

export function withoutRecommendedWait(view: DetailView): DetailView {
  if (view.type === "loading") return view;
  if (view.type === "empty") {
    const { waitingLabel: _label, previewTimedSupply: _supply, previewEvidence: _evidence, ...rest } = view;
    return rest;
  }
  const { recommendedWaitDays: _removed, recommendedWaitAt: _at, waitingLabel: _label,
    focusRequestedSummary: _focus, previewTimedSupply: _supply, previewEvidence: _evidence, ...rest } = view;
  return rest;
}

/** Called only with output already validated by the request-owning service H14 client. */
export function projectServiceCertifiedResult(
  input: SolverInput,
  output: ServiceH14Output,
  final: boolean,
  verifiedPrefix = false,
): ServiceCertifiedSolveOutcome {
  let action: ServiceCertifiedResult["action"] = null;
  // The signed OFF route has D0 physical evidence, never a wait verdict.
  const d0 = final && output.status === "withheld" && output.reason === "legacy_current_only";
  const preview = adaptiveShell;
  const choice = final ? conditionalCurrent(output, input.start,
    [input.stock.blue, input.stock.purple, input.stock.yellow], {legacyD0:d0, verifiedPrefix:preview && verifiedPrefix, currentBatch:preview}) : null;
  const allowed = choice && (preview || (d0 && choice.kind === "conditional-current") ||
    choice.kind === "strict" || choice.kind === "practical" ||
    (choice.kind === "conditional-current" && output.adaptive?.actionable === "unresolved"));
  if (choice && allowed) {
    const {kit, uses} = choice;
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

function hasCompleteHorizon(value: ServiceCertifiedResult): boolean {
  const { output, final } = value;
  return final && output.status === "complete" && output.reason === null &&
    output.accuracy.practical && output.profile.policy === "adaptive-next-batch-balanced-v1" &&
    output.records.length === 15 && output.records.every((record, day) => record.day === day);
}

function certifiedAdaptive(value: ServiceCertifiedResult) {
  return !value.previewLegacyD0 && !value.interruption && hasCompleteHorizon(value)
    ? value.output.adaptive : undefined;
}

function waitDays(a: ServiceH14Output["adaptive"], horizon: number): number | undefined {
  return a?.actionable === "wait" && a.mathematical === "wait" && a.nextDay !== null &&
    Number.isInteger(a.nextDay) && a.nextDay >= 1 && a.nextDay <= horizon ? a.nextDay : undefined;
}

/** Full-horizon analytics only. A prefix verdict is presentation evidence, not H14. */
export function serviceCertifiedWaitDays(value: ServiceCertifiedResult): number | undefined {
  return waitDays(certifiedAdaptive(value), 14);
}

function previewNonDateStatus(adaptive: ServiceH14Output["adaptive"]) {
  const delta = adaptive?.delta;
  if (!adaptive || !delta || !Number.isFinite(delta.lower) || !Number.isFinite(delta.upper) ||
      delta.lower > delta.upper) return "comparisonUnavailable";
  // The certified flags compare the exact bounds; the published endpoints are
  // rounded outwards and must not be used to reclassify a threshold equality.
  if (adaptive.actionable === "unresolved") return "benefitUncertain";
  if (adaptive.actionable === "no_material_wait") {
    if (adaptive.mathematical === "use_now") return "noBenefit";
    if (adaptive.mathematical === "wait") return "smallBenefit";
    return "noMaterialBenefit";
  }
  return "comparisonUnavailable";
}

export function serviceCertifiedViews(
  input: SolverInput,
  value: ServiceCertifiedResult,
): { result: ResultView; detail: DetailView } {
  const views = serviceCertifiedBaseViews(input, value);
  const { output, final } = value;
  const legacyD0 = value.previewLegacyD0 === true;
  const preview = adaptiveShell;
  const partial = preview && !!output.current && output.status === "incomplete" &&
    (value.interruption === "resource" || value.interruption === "memory" || value.interruption === "deadline") &&
    output.records.length > 0 && output.records.every((row, day) => row.day === day);
  const prefix = partial && final ? output.prefixDecision : undefined;
  const verifiedPrefix = prefix && prefix.horizon >= 1 && prefix.horizon < 14 &&
    prefix.horizon === output.sourceCertificate?.completedThrough &&
    prefix.horizon === output.records.length - 1 ? prefix : undefined;
  const adaptive = verifiedPrefix?.verdict ?? certifiedAdaptive(value);
  const waitDay = waitDays(adaptive, verifiedPrefix?.horizon ?? 14);
  const nextAt = adaptive?.nextAt;
  const waitAt = preview && waitDay !== undefined && typeof nextAt === "string" &&
    Number.isFinite(Date.parse(nextAt)) && new Date(nextAt).toISOString() === nextAt ? nextAt : undefined;
  const previewStatus = waitAt !== undefined ? "date" : previewNonDateStatus(adaptive);
  if (value.userRequestedDecision && adaptive && views.detail.type === "metrics" &&
      ((preview ? waitAt !== undefined : adaptive.actionable === "wait") || value.action)) views.detail.focusRequestedSummary = true;
  const status = output.status === "error" ? "error"
    : output.status === "claim_required" ? "claim"
    : legacyD0 ? "d0Only"
    : output.status === "withheld" ? "withheld"
    : !output.current ? "error"
    : partial ? previewStatus
    : output.current.status === "complete" ? "complete"
    : !final || output.status === "incomplete" ? "incomplete"
    : preview ? previewStatus
    : waitDay !== undefined ? "date"
    : adaptive?.actionable === "no_material_wait"
      ? (adaptive.mathematical === "wait" ? "smallWait" : "noMaterialWait")
      : "unresolved";
  if (views.detail.type !== "loading" && status !== "date")
    views.detail = { ...views.detail, waitingLabel: !preview && adaptive?.practicalFirstKit && value.action?.kit === adaptive.practicalFirstKit
      ? message(`detail.wait.practical.${adaptive.practicalFirstKit}`, {count:value.action.run.count}) : message(`detail.wait.${status}`) };
  if (views.detail.type === "metrics" && status === "date") {
    views.detail.waitingLabel = message("detail.wait.nextSupply");
    if (waitAt !== undefined) views.detail.recommendedWaitAt = waitAt;
    if (waitDay !== undefined) views.detail.recommendedWaitDays = waitDay;
  }
  if (preview && (final || partial) &&
      (!legacyD0 || (output.status === "withheld" && output.reason === "legacy_current_only"))) {
    const current = output.current;
    const records = output.records;
    const ordered = records.length <= 15 && records.every((record, day) => record.day === day);
    views.detail.previewEvidence = {
      ...(partial ? {prefixMetrics:records.map(({day,value:{p,c}}) => ({
        day, probability:[p.lower,p.upper] as [number,number], pieces:[c.lower,c.upper] as [number,number],
      }))} : {}),
      ...(value.previewConditional ? {conditional:true as const} : {}),
      ...(legacyD0 ? { legacyD0: true as const } : {}),
      action: (!partial || final) && current?.status === "use_certified" && current.kit ? {
        kit: current.kit, count: current.uses,
        tied: (["blue", "purple", "yellow"] as const).filter((kit, index) =>
          kit !== current.kit && (current.optimalActionMask & (1 << index)) !== 0),
        probability: formatReadablePercent(current.value.display.successP, 2),
        pieces: current.value.display.expectedTotalConsumptionC,
      } : null,
      lastDay: ordered && records.length ? records[records.length - 1]!.day : null,
      complete: !partial && (status === "date" || status === "noBenefit" || status === "smallBenefit" || status === "noMaterialBenefit"),
      ...(verifiedPrefix && previewStatus !== "comparisonUnavailable" ? { prefixComparison: true as const } : {}),
      ...(status === "comparisonUnavailable" ? { comparison: "unavailable" as const } :
        status === "benefitUncertain" ? { comparison: "bounded" as const } : {}),
      withheld: output.status === "withheld" || output.status === "claim_required",
      source: [output.forecastIdentity.forecastId, output.forecastIdentity.snapshotRevision, value.previewSourceStatus].filter(Boolean).join(" · "),
      reason: value.interruption ?? output.reason,
    };
    if (!legacyD0) views.detail.previewTimedSupply = value.previewTimedSupply ?? null;
  }
  return views;
}

function serviceCertifiedBaseViews(
  input: SolverInput,
  value: ServiceCertifiedResult,
): { result: ResultView; detail: DetailView } {
  const { output, action } = value;
  const solverLabel = value.previewLegacyD0 ? "Rust/WASM · D0"
    : adaptiveShell && value.interruption && output.records.length
      ? `Rust/WASM · ${output.records.length === 1 ? "D0" : `D0–D${output.records.length-1}`}`
      : "Rust/WASM · exact Current / bounded H14";
  if (output.status === "claim_required" || (output.status === "withheld" && !value.final)) {
    const explanation = message(output.status === "claim_required"
      ? "result.certifiedClaimRequired" : "result.certifiedForecastWithheld");
    return {
      result: { type: "error", reason: output.status === "claim_required" ? "certified_claim_required" : "solver_failure", message: explanation },
      detail: { type: "empty", message: explanation },
    };
  }
  if (output.status === "error" || !output.current) {
    const explanation = message("result.solverError");
    return {
      result: { type: "error", reason: "solver_failure", message: explanation },
      detail: { type: "empty", message: explanation },
    };
  }
  if (input.start.grade === "SR" && input.start.level === 15) {
    return {
      result: { type: "callout", reason: "final_target", message: message("result.complete") },
      detail: { type: "empty", message: message("result.complete") },
    };
  }
  if (!value.interruption && input.start.grade === "R" && input.start.level === 15) {
    return {
      result: { type: "convertRecommendation", reason: "r15_conversion" },
      detail: { type: "empty", message: message("result.convertAvailable") },
    };
  }
  if (!action) {
    const preview = adaptiveShell;
    const preserve = !preview && value.previewLegacyD0 && output.current.status === "preserve";
    const explanation = preview
      ? value.interruption ? previewStopMessage(value.interruption, value.followUp)
        : message(Object.values(input.stock).some(pieces => pieces >= 10)
          ? "result.previewActionUnavailable" : "result.previewNoUsableKit")
      : message(preserve ? "result.certifiedPreserve" : "detail.wait.noFirstKit");
    return {
      result: { type: "callout", reason: preserve ? "certified_preserve" : "adaptive_no_first_kit", message: explanation },
      detail: {
        type: "metrics",
        successProbability: formatReadablePercent(output.current.value.display.successP, 2),
        greatSuccessProbability: null,
        candidates: [],
        monteCarloRuns: 0,
        solverLabel,
      },
    };
  }
  return {
    result: {
      type: "recommendation",
      kit: action.kit,
      count: action.run.count,
      ...(value.final && output.status === "incomplete" && value.interruption ? {stockOnlyAction:true as const} : {}),
      ...((value.output.adaptive || adaptiveShell) && action.run.count > 1
        ? { batchAction: true as const } : {}),
      ...(adaptiveShell ||
        (output.adaptive?.actionable === "unresolved" && output.current.kit === action.kit)
        ? { conditionalAction: true as const } :
        value.output.adaptive?.practicalFirstKit === action.kit ? { practicalAction: true as const } : {}),
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
      solverLabel,
    },
  };
}
