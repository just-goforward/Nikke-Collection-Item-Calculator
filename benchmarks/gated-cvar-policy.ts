import {
  type CollectionState,
  clampMemoStockUses,
  EXPECTED_28_DAY_GAIN,
  isConvertStateNormalized,
  isTerminalNormalized,
  type Kit,
  type KitVector,
  stateIdNormalized,
  stockToUses,
  transitionNormalized,
} from "../src/solver/domain";
import type { SolverInput } from "../src/types";
import type { RustCoreExports } from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";

const KITS = ["blue", "purple", "yellow"] as const;
const STRICT_EPSILON = 1e-12;

export type GatedCvarDecision = {
  baselineCvar: number;
  baselineMean: number;
  baselineAction: Kit | null;
  candidateCvar: number | null;
  candidateMean: number | null;
  eta: number | null;
  firstAction: Kit | null;
  actionChanged: boolean;
  selectedPolicy: "phase2" | "gated_cvar_one_step";
  successGap: number;
};

type GatedCvarOptions = {
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

function decrementUses(stock: KitVector, kit: Kit): KitVector {
  return {
    blue: stock.blue - Number(kit === "blue"),
    purple: stock.purple - Number(kit === "purple"),
    yellow: stock.yellow - Number(kit === "yellow"),
  };
}

function recommendedRunCount(
  start: CollectionState,
  stock: KitVector,
  action: Kit,
  actionAt: (stateId: number, blue: number, purple: number, yellow: number) => number,
) {
  let state = start;
  let uses = stock;
  const actionIndex = KITS.indexOf(action);
  if (uses[action] <= 0) return 0;
  const successTarget = transitionNormalized(state, action).success;
  let count = 0;
  while (
    count < 100 &&
    !isTerminalNormalized(state) &&
    !isConvertStateNormalized(state) &&
    uses[action] > 0
  ) {
    if (
      count > 0 &&
      actionAt(stateIdNormalized(state), uses.blue, uses.purple, uses.yellow) !== actionIndex
    ) {
      break;
    }
    const edge = transitionNormalized(state, action);
    if (stateIdNormalized(edge.success) !== stateIdNormalized(successTarget)) break;
    count += 1;
    uses = decrementUses(uses, action);
    const leveled = edge.fail.grade !== state.grade || edge.fail.level !== state.level;
    state = edge.fail;
    if (leveled) break;
  }
  return count;
}

export function createGatedCvarPolicySolver(
  exports: RustCoreExports,
  options: GatedCvarOptions = {},
) {
  const alpha = options.alpha ?? 0.9;
  const etas = options.etas ?? [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6];
  const horizonFactor = options.horizonFactor ?? 0.75;
  const normPower = options.normPower ?? 3;
  const tolerance = options.tolerance ?? 0;
  if (!(alpha > 0 && alpha < 1)) throw new Error("CVaR alpha must be between zero and one.");
  if (etas.length === 0 || etas.some((eta) => !Number.isFinite(eta))) {
    throw new Error("CVaR eta candidates must be finite and non-empty.");
  }
  const decisions: GatedCvarDecision[] = [];

  function solve(input: SolverInput): ExactPolicySolverResult {
    const sid = stateIdNormalized(input.start);
    const pieces = input.stock;
    requireFunction(exports, "cvarSetup")(
      sid,
      pieces.blue | 0,
      pieces.purple | 0,
      pieces.yellow | 0,
      EXPECTED_28_DAY_GAIN.blue,
      EXPECTED_28_DAY_GAIN.purple,
      EXPECTED_28_DAY_GAIN.yellow,
      horizonFactor,
      normPower,
      tolerance,
    );
    assertStatus(exports, "CVaR setup");

    const baselineMean = requireFunction(exports, "cvarFollowMean")();
    assertStatus(exports, "phase2 mean");
    const maximumSuccess = requireFunction(exports, "rootCandidateMaxSuccessProb")();
    let baselineCvar = Number.POSITIVE_INFINITY;
    for (const eta of etas) {
      const hinge = requireFunction(exports, "cvarFollowHinge")(eta);
      assertStatus(exports, "phase2 hinge");
      baselineCvar = Math.min(baselineCvar, eta + hinge / (1 - alpha));
    }

    let best:
      | { actionIndex: number; cvar: number; eta: number; mean: number; success: number }
      | undefined;
    for (let candidateAction = 0; candidateAction < KITS.length; candidateAction += 1) {
      if (requireFunction(exports, "rootCandidateValid")(candidateAction) === 0) continue;
      const success = requireFunction(exports, "rootCandidateSuccessProb")(candidateAction);
      if (success < maximumSuccess - STRICT_EPSILON) continue;
      const mean = requireFunction(exports, "cvarFollowMeanAfterFirstAction")(candidateAction);
      assertStatus(exports, "one-step CVaR mean");
      if (mean > baselineMean + STRICT_EPSILON) continue;
      for (const eta of etas) {
        const hinge = requireFunction(exports, "cvarFollowHingeAfterFirstAction")(
          eta,
          candidateAction,
        );
        assertStatus(exports, "one-step CVaR hinge");
        const cvar = eta + hinge / (1 - alpha);
        if (!best || cvar < best.cvar - STRICT_EPSILON) {
          best = { actionIndex: candidateAction, cvar, eta, mean, success };
        }
      }
    }

    const uses = clampMemoStockUses(stockToUses(pieces));
    const phase2ActionAt = requireFunction(exports, "policyActionAt");
    const baselineActionIndex = phase2ActionAt(sid, uses.blue, uses.purple, uses.yellow);
    const baselineAction = baselineActionIndex >= 0 ? (KITS[baselineActionIndex] ?? null) : null;
    let actionIndex: number;
    let actionAt: (stateId: number, blue: number, purple: number, yellow: number) => number;
    let selectedPolicy: GatedCvarDecision["selectedPolicy"] = "phase2";
    let selectedCvar: number | null = null;
    let selectedMean: number | null = null;
    let selectedEta: number | null = null;
    let selectedSuccess: number;
    if (best && best.cvar < baselineCvar - STRICT_EPSILON) {
      actionAt = phase2ActionAt;
      actionIndex = best.actionIndex;
      selectedPolicy = "gated_cvar_one_step";
      selectedCvar = best.cvar;
      selectedMean = best.mean;
      selectedEta = best.eta;
      selectedSuccess = best.success;
    } else {
      actionAt = phase2ActionAt;
      actionIndex = actionAt(sid, uses.blue, uses.purple, uses.yellow);
      selectedSuccess =
        actionIndex >= 0 ? requireFunction(exports, "rootCandidateSuccessProb")(actionIndex) : 0;
    }

    const firstAction = actionIndex >= 0 ? (KITS[actionIndex] ?? null) : null;
    const probabilityGap = Math.max(0, maximumSuccess - selectedSuccess);
    decisions.push({
      baselineCvar,
      baselineMean,
      baselineAction,
      candidateCvar: selectedCvar,
      candidateMean: selectedMean,
      eta: selectedEta,
      firstAction,
      actionChanged: firstAction !== baselineAction,
      selectedPolicy,
      successGap: probabilityGap,
    });
    if (!firstAction) return { possible: false, best: null };

    const runCount = recommendedRunCount(input.start, uses, firstAction, actionAt);
    return {
      possible: true,
      best: {
        firstAction,
        probabilityGap,
        run: { count: Math.max(1, runCount) },
      },
    };
  }

  return { decisions, solve };
}
