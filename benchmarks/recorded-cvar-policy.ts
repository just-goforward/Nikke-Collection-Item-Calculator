import { KIT_ORDER, stateIdNormalized } from "../src/solver/domain";
import type { SolverInput } from "../src/types";
import { normalizeRustProductInput } from "../src/wasm/rustProductInput";
import { buildRecommendedRunForKit } from "../src/wasm/rustProductView";
import type { RustCoreExports } from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";

const STRICT_EPSILON = 1e-12;

export const RECORDED_CVAR_OPTIONS = {
  alpha: 0.9,
  etas: [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6],
  horizonFactor: 0.75,
  normPower: 3,
  tolerance: 0,
} as const;

export type RecordedCvarSample = {
  eta: number;
  optimizedHinge: number;
  recordedHinge: number;
  recordedHingeDelta: number;
  candidateCvar: number;
  candidateMean: number;
  candidateSuccess: number;
  firstAction: (typeof KIT_ORDER)[number] | null;
  meanNonWorse: boolean;
  successNonWorse: boolean;
};

export type RecordedCvarDecision = {
  baselineAction: (typeof KIT_ORDER)[number] | null;
  baselineRunCount: number;
  baselineMean: number;
  baselineCvar: number;
  maximumSuccess: number;
  selectedPolicy: "phase2" | "recorded_cvar";
  firstAction: (typeof KIT_ORDER)[number] | null;
  runCount: number;
  selectedEta: number | null;
  selectedCvar: number | null;
  selectedMean: number | null;
  selectedSuccess: number;
  probabilityGap: number;
  actionChanged: boolean;
  runChanged: boolean;
  decisionChanged: boolean;
  samples: RecordedCvarSample[];
};

type RecordedCvarOptions = {
  alpha?: number;
  etas?: readonly number[];
  horizonFactor?: number;
  normPower?: number;
  tolerance?: number;
};

function requireFunction<T extends keyof RustCoreExports>(
  exports: RustCoreExports,
  name: T,
): NonNullable<RustCoreExports[T]> {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`Missing WASM export: ${String(name)}`);
  return value as NonNullable<RustCoreExports[T]>;
}

function assertStatus(exports: RustCoreExports, operation: string) {
  const status = exports.getSolveStatus?.() ?? 0;
  if (status !== 0) throw new Error(`${operation} failed with solver status ${status}.`);
}

export function createRecordedCvarPolicySolver(
  exports: RustCoreExports,
  options: RecordedCvarOptions = RECORDED_CVAR_OPTIONS,
) {
  const alpha = options.alpha ?? RECORDED_CVAR_OPTIONS.alpha;
  const etas = options.etas ?? RECORDED_CVAR_OPTIONS.etas;
  const horizonFactor = options.horizonFactor ?? RECORDED_CVAR_OPTIONS.horizonFactor;
  const normPower = options.normPower ?? RECORDED_CVAR_OPTIONS.normPower;
  const tolerance = options.tolerance ?? RECORDED_CVAR_OPTIONS.tolerance;
  if (!(alpha > 0 && alpha < 1)) throw new Error("CVaR alpha must be between zero and one.");
  if (etas.length === 0 || etas.some((eta) => !Number.isFinite(eta))) {
    throw new Error("CVaR eta candidates must be finite and non-empty.");
  }
  const decisions: RecordedCvarDecision[] = [];

  function solve(input: SolverInput): ExactPolicySolverResult {
    const normalized = normalizeRustProductInput(input);
    const sid = stateIdNormalized(normalized.start);
    requireFunction(exports, "cvarSetup")(
      sid,
      normalized.stock.blue | 0,
      normalized.stock.purple | 0,
      normalized.stock.yellow | 0,
      horizonFactor,
      normPower,
      tolerance,
    );
    assertStatus(exports, "CVaR setup");

    const phase2ActionAt = requireFunction(exports, "policyActionAt");
    const recordedActionAt = requireFunction(exports, "cvarRecordedActionAt");
    const baselineActionIndex = phase2ActionAt(
      sid,
      normalized.stockUses.blue,
      normalized.stockUses.purple,
      normalized.stockUses.yellow,
    );
    const baselineAction = actionFromIndex(baselineActionIndex);
    const baselineRun = buildRecommendedRunForKit(
      normalized,
      (state, stockUses) =>
        actionFromIndex(
          phase2ActionAt(
            stateIdNormalized(state),
            stockUses.blue,
            stockUses.purple,
            stockUses.yellow,
          ),
        ),
      baselineAction,
    );
    const baselineMean = requireFunction(exports, "cvarFollowMean")();
    assertStatus(exports, "CVaR baseline mean");
    const maximumSuccess = requireFunction(exports, "rootCandidateMaxSuccessProb")();
    let baselineCvar = Number.POSITIVE_INFINITY;
    for (const eta of etas) {
      const hinge = requireFunction(exports, "cvarFollowHinge")(eta);
      assertStatus(exports, "CVaR baseline hinge");
      baselineCvar = Math.min(baselineCvar, eta + hinge / (1 - alpha));
    }

    const samples: RecordedCvarSample[] = [];
    for (const eta of etas) {
      const optimizedHinge = requireFunction(exports, "cvarOptRecord")(eta);
      assertStatus(exports, "CVaR recorded optimization");
      const candidateMean = requireFunction(exports, "cvarFollowRecordedMean")();
      assertStatus(exports, "CVaR recorded mean");
      const recordedHinge = requireFunction(exports, "cvarFollowRecordedHinge")(eta);
      assertStatus(exports, "CVaR recorded hinge");
      const candidateSuccess = requireFunction(exports, "cvarFollowRecordedSuccess")();
      assertStatus(exports, "CVaR recorded success");
      const actionIndex = recordedActionAt(
        sid,
        normalized.stockUses.blue,
        normalized.stockUses.purple,
        normalized.stockUses.yellow,
      );
      samples.push({
        eta,
        optimizedHinge,
        recordedHinge,
        recordedHingeDelta: recordedHinge - optimizedHinge,
        candidateCvar: eta + recordedHinge / (1 - alpha),
        candidateMean,
        candidateSuccess,
        firstAction: actionFromIndex(actionIndex),
        meanNonWorse: candidateMean <= baselineMean + STRICT_EPSILON,
        successNonWorse: candidateSuccess >= maximumSuccess - STRICT_EPSILON,
      });
    }

    const best = selectRecordedCvarCandidate(samples, baselineCvar);
    let selectedPolicy: RecordedCvarDecision["selectedPolicy"] = "phase2";
    let firstAction = baselineAction;
    let runCount = baselineRun?.count ?? 0;
    let selectedSuccess =
      baselineActionIndex >= 0
        ? requireFunction(exports, "rootCandidateSuccessProb")(baselineActionIndex)
        : 0;
    if (best) {
      requireFunction(exports, "cvarOptRecord")(best.eta);
      assertStatus(exports, "CVaR selected-policy restore");
      const selectedActionIndex = recordedActionAt(
        sid,
        normalized.stockUses.blue,
        normalized.stockUses.purple,
        normalized.stockUses.yellow,
      );
      firstAction = actionFromIndex(selectedActionIndex);
      const selectedRun = buildRecommendedRunForKit(
        normalized,
        (state, stockUses) =>
          actionFromIndex(
            recordedActionAt(
              stateIdNormalized(state),
              stockUses.blue,
              stockUses.purple,
              stockUses.yellow,
            ),
          ),
        firstAction,
      );
      runCount = selectedRun?.count ?? 0;
      selectedSuccess = best.candidateSuccess;
      selectedPolicy = "recorded_cvar";
    }

    const probabilityGap = Math.max(0, maximumSuccess - selectedSuccess);
    const decision: RecordedCvarDecision = {
      baselineAction,
      baselineRunCount: baselineRun?.count ?? 0,
      baselineMean,
      baselineCvar,
      maximumSuccess,
      selectedPolicy,
      firstAction,
      runCount,
      selectedEta: best?.eta ?? null,
      selectedCvar: best?.candidateCvar ?? null,
      selectedMean: best?.candidateMean ?? null,
      selectedSuccess,
      probabilityGap,
      actionChanged: firstAction !== baselineAction,
      runChanged: runCount !== (baselineRun?.count ?? 0),
      decisionChanged: firstAction !== baselineAction || runCount !== (baselineRun?.count ?? 0),
      samples,
    };
    decisions.push(decision);
    if (!firstAction || runCount <= 0) return { possible: false, best: null };
    return {
      possible: true,
      best: { firstAction, probabilityGap, run: { count: runCount } },
    };
  }

  return { decisions, solve };
}

export function selectRecordedCvarCandidate(
  samples: readonly RecordedCvarSample[],
  baselineCvar: number,
): RecordedCvarSample | null {
  let best: RecordedCvarSample | null = null;
  for (const sample of samples) {
    if (!sample.meanNonWorse || !sample.successNonWorse || !sample.firstAction) continue;
    if (Math.abs(sample.recordedHingeDelta) > STRICT_EPSILON) continue;
    if (sample.candidateCvar >= baselineCvar - STRICT_EPSILON) continue;
    if (!best || sample.candidateCvar < best.candidateCvar - STRICT_EPSILON) best = sample;
  }
  return best;
}

function actionFromIndex(index: number) {
  return index >= 0 ? (KIT_ORDER[index] ?? null) : null;
}
