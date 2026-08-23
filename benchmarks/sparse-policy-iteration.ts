import {
  type CollectionState,
  clampMemoStockUses,
  convertState,
  EXPECTED_28_DAY_GAIN,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  type Kit,
  type KitVector,
  stateIdNormalized,
  stockToUses,
  transitionNormalized,
} from "../src/solver/domain";
import type { SolverInput } from "../src/types";
import type { RustCoreExports } from "../src/wasm/rustTypes";
import type { ExactPolicySolverResult } from "./evaluator/exact-replan-types";

type UsesState = { sid: number; blue: number; purple: number; yellow: number };

export type SparsePolicyValue = {
  cost: number;
  success: number;
  totalUses: number;
  vector: [number, number, number];
};

export type SparsePolicyIterationStep = {
  iteration: number;
  rootAction: number;
  nextRootAction: number;
  nextRunCount: number;
  rootCost: number;
  rootSuccess: number;
  rootTotalUses: number;
  policyStates: number;
  closureStates: number;
  improvementStates: number;
  evaluatedStates: number;
  successInvariantChecks: number;
  changes: number;
  overrides: number;
};

export type SparsePolicyIterationOutcome =
  | "completed"
  | "phase2_failure"
  | "iteration_budget_exceeded"
  | "state_budget_exceeded"
  | "time_budget_exceeded";

export type SparsePolicyIterationResult = {
  outcome: SparsePolicyIterationOutcome;
  setupStatus: number;
  elapsedMs: number;
  iterations: SparsePolicyIterationStep[];
  finalOverrides: number;
  finalAction: Kit | null;
  finalValue: SparsePolicyValue | null;
  closureStates: number;
  probabilityGap: number;
  runCount: number;
};

export type SparsePolicyIterationOptions = {
  acceptIterationBudget?: boolean;
  horizonFactor?: number;
  maxIterations?: number;
  maxStates?: number;
  memoTier?: number;
  normPower?: number;
  timeBudgetMs?: number;
  tolerance?: number;
};

export type SparsePolicyIterationDecision = {
  input: SolverInput;
  result: SparsePolicyIterationResult;
};

const BLUE_DIMENSION = 221;
const PURPLE_DIMENSION = 89;
const YELLOW_DIMENSION = 45;
const STRICT_EPSILON = 1e-12;

class SparsePolicyBudgetExceeded extends Error {
  constructor(
    readonly outcome: Extract<SparsePolicyIterationOutcome, `${string}_budget_exceeded`>,
    readonly observedStates: number,
  ) {
    super(outcome);
  }
}

function requireFunction<T extends keyof RustCoreExports>(
  exports: RustCoreExports,
  name: T,
): NonNullable<RustCoreExports[T]> {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`Missing WASM export: ${String(name)}`);
  return value as NonNullable<RustCoreExports[T]>;
}

function pack(state: UsesState) {
  return (
    ((state.sid * BLUE_DIMENSION + state.blue) * PURPLE_DIMENSION + state.purple) *
      YELLOW_DIMENSION +
    state.yellow
  );
}

function unpack(key: number): UsesState {
  const yellow = key % YELLOW_DIMENSION;
  const withoutYellow = (key - yellow) / YELLOW_DIMENSION;
  const purple = withoutYellow % PURPLE_DIMENSION;
  const withoutPurple = (withoutYellow - purple) / PURPLE_DIMENSION;
  const blue = withoutPurple % BLUE_DIMENSION;
  const sid = (withoutPurple - blue) / BLUE_DIMENSION;
  return { sid, blue, purple, yellow };
}

function decodeState(sid: number): CollectionState {
  return {
    grade: sid >= 480 ? "SR" : "R",
    level: Math.floor(sid / 30) % 16,
    exp: (sid % 30) * 100,
  };
}

function decrement(state: UsesState, action: number): UsesState {
  return {
    ...state,
    blue: state.blue - Number(action === 0),
    purple: state.purple - Number(action === 1),
    yellow: state.yellow - Number(action === 2),
  };
}

function decrementUses(stock: KitVector, kit: Kit): KitVector {
  return {
    blue: stock.blue - Number(kit === "blue"),
    purple: stock.purple - Number(kit === "purple"),
    yellow: stock.yellow - Number(kit === "yellow"),
  };
}

function combine(
  probability: number,
  success: SparsePolicyValue,
  failure: SparsePolicyValue,
): SparsePolicyValue {
  return {
    cost: probability * success.cost + (1 - probability) * failure.cost,
    success: probability * success.success + (1 - probability) * failure.success,
    totalUses: probability * success.totalUses + (1 - probability) * failure.totalUses,
    vector: [
      probability * success.vector[0] + (1 - probability) * failure.vector[0],
      probability * success.vector[1] + (1 - probability) * failure.vector[1],
      probability * success.vector[2] + (1 - probability) * failure.vector[2],
    ],
  };
}

function isBetter(candidate: SparsePolicyValue, incumbent: SparsePolicyValue) {
  const costDelta = candidate.cost - incumbent.cost;
  if (Math.abs(costDelta) > STRICT_EPSILON) return costDelta < 0;
  const totalDelta = candidate.totalUses - incumbent.totalUses;
  if (Math.abs(totalDelta) > STRICT_EPSILON) return totalDelta < 0;
  return candidate.success > incumbent.success;
}

function recommendedRunCount(
  start: CollectionState,
  stock: KitVector,
  action: Kit,
  actionAt: (stateId: number, blue: number, purple: number, yellow: number) => number,
) {
  let state = start;
  let uses = stock;
  const actionIndex = KIT_ORDER.indexOf(action);
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

type PolicyActionAt = (stateId: number, blue: number, purple: number, yellow: number) => number;

type SparsePolicyConfig = {
  horizonFactor: number;
  maxIterations: number;
  maxStates: number;
  memoTier: number;
  normPower: number;
  timeBudgetMs: number;
  tolerance: number;
};

type SparsePolicyContext = {
  baselineActionAt: PolicyActionAt;
  checkBudget: (size: number) => void;
  input: SolverInput;
  iterations: SparsePolicyIterationStep[];
  leaf: (state: UsesState) => SparsePolicyValue;
  maxIterations: number;
  overrides: Map<number, number>;
  start: UsesState;
  successForAction: NonNullable<RustCoreExports["phase2MaxSuccessForActionAt"]>;
  tolerance: number;
  uses: KitVector;
};

type PolicyEvaluation = {
  actionAt: (state: UsesState) => number;
  reachable: Set<number>;
  value: (state: UsesState, collectReachable: boolean) => SparsePolicyValue;
  values: Map<number, SparsePolicyValue>;
};

type EligibleAction = {
  action: number;
  edge: ReturnType<typeof transitionNormalized>;
  maximumSuccess: number;
};

type EligibleActionSet = {
  actions: EligibleAction[];
  stateMaximumSuccess: number;
};

function resolveSparsePolicyConfig(options: SparsePolicyIterationOptions): SparsePolicyConfig {
  const tolerance = options.tolerance ?? 0;
  if (tolerance !== 0) {
    throw new Error("Exact sparse policy iteration currently proves only the tau=0 contract.");
  }
  return {
    horizonFactor: options.horizonFactor ?? 0.75,
    maxIterations: Math.max(1, Math.trunc(options.maxIterations ?? 40)),
    maxStates: Math.max(1, Math.trunc(options.maxStates ?? 1_200_000)),
    memoTier: Math.min(24, Math.max(16, Math.trunc(options.memoTier ?? 22))),
    normPower: options.normPower ?? 3,
    timeBudgetMs: Math.max(1, Number(options.timeBudgetMs ?? 300_000)),
    tolerance,
  };
}

function createLeafEvaluator(
  input: SolverInput,
  uses: KitVector,
  horizonFactor: number,
  normPower: number,
) {
  const startUses = [uses.blue, uses.purple, uses.yellow] as const;
  const denominators = [
    input.stock.blue + horizonFactor * EXPECTED_28_DAY_GAIN.blue,
    input.stock.purple + horizonFactor * EXPECTED_28_DAY_GAIN.purple,
    input.stock.yellow + horizonFactor * EXPECTED_28_DAY_GAIN.yellow,
  ] as const;
  return (state: UsesState): SparsePolicyValue => {
    const vector = [
      (startUses[0] - state.blue) * 10,
      (startUses[1] - state.purple) * 10,
      (startUses[2] - state.yellow) * 10,
    ] as [number, number, number];
    const ratios = [
      vector[0] / denominators[0],
      vector[1] / denominators[1],
      vector[2] / denominators[2],
    ] as const;
    const cost =
      normPower === Number.POSITIVE_INFINITY
        ? Math.max(...ratios)
        : (ratios[0] ** normPower + ratios[1] ** normPower + ratios[2] ** normPower) **
          (1 / normPower);
    return {
      cost,
      success: 0,
      totalUses: vector[0] / 10 + vector[1] / 10 + vector[2] / 10,
      vector,
    };
  };
}

function createSparsePolicyContext(
  exports: RustCoreExports,
  input: SolverInput,
  config: SparsePolicyConfig,
  startedAt: number,
): SparsePolicyContext {
  const uses = clampMemoStockUses(stockToUses(input.stock));
  return {
    baselineActionAt: requireFunction(exports, "policyActionAt"),
    checkBudget(size) {
      if (size > config.maxStates) {
        throw new SparsePolicyBudgetExceeded("state_budget_exceeded", size);
      }
      if (performance.now() - startedAt > config.timeBudgetMs) {
        throw new SparsePolicyBudgetExceeded("time_budget_exceeded", size);
      }
    },
    input,
    iterations: [],
    leaf: createLeafEvaluator(input, uses, config.horizonFactor, config.normPower),
    maxIterations: config.maxIterations,
    overrides: new Map(),
    start: { sid: stateIdNormalized(input.start), ...uses },
    successForAction: requireFunction(exports, "phase2MaxSuccessForActionAt"),
    tolerance: config.tolerance,
    uses,
  };
}

function policyActionAt(context: SparsePolicyContext, state: UsesState) {
  return (
    context.overrides.get(pack(state)) ??
    context.baselineActionAt(state.sid, state.blue, state.purple, state.yellow)
  );
}

function createPolicyEvaluation(context: SparsePolicyContext): PolicyEvaluation {
  const values = new Map<number, SparsePolicyValue>();
  const reachable = new Set<number>();
  const actionAt = (state: UsesState) => policyActionAt(context, state);
  const value = (state: UsesState, collectReachable: boolean): SparsePolicyValue => {
    const key = pack(state);
    const cached = values.get(key);
    if (cached) {
      if (collectReachable) reachable.add(key);
      return cached;
    }
    context.checkBudget(values.size);
    if (collectReachable) reachable.add(key);
    const decoded = decodeState(state.sid);
    if (isTerminalNormalized(decoded)) {
      const terminal = { ...context.leaf(state), success: 1 };
      values.set(key, terminal);
      return terminal;
    }
    if (isConvertStateNormalized(decoded)) {
      const converted = value(
        { ...state, sid: stateIdNormalized(convertState()) },
        collectReachable,
      );
      values.set(key, converted);
      return converted;
    }
    const action = actionAt(state);
    const kit = KIT_ORDER[action];
    if (!kit || state[kit] <= 0) {
      const depleted = context.leaf(state);
      values.set(key, depleted);
      return depleted;
    }
    const edge = transitionNormalized(decoded, kit);
    const nextStock = decrement(state, action);
    const combined = combine(
      edge.probability,
      value({ ...nextStock, sid: stateIdNormalized(edge.success) }, collectReachable),
      value({ ...nextStock, sid: stateIdNormalized(edge.fail) }, collectReachable),
    );
    values.set(key, combined);
    return combined;
  };
  return { actionAt, reachable, value, values };
}

function potentiallyEligibleActions(
  context: SparsePolicyContext,
  state: UsesState,
  decoded: CollectionState,
): EligibleActionSet {
  const actionSuccesses = KIT_ORDER.map((kit, action) => {
    if (state[kit] <= 0) return -1;
    const maximum = context.successForAction(
      state.sid,
      state.blue,
      state.purple,
      state.yellow,
      action,
    );
    if (!Number.isFinite(maximum) || maximum < 0) {
      throw new Error(
        `Phase2 maximum-success lookup failed for state ${pack(state)} action ${action}.`,
      );
    }
    return maximum;
  });
  const stateMaximumSuccess = Math.max(...actionSuccesses);
  const eligible: EligibleAction[] = [];
  for (let action = 0; action < KIT_ORDER.length; action += 1) {
    const kit = KIT_ORDER[action];
    const actionSuccess = actionSuccesses[action];
    if (
      kit &&
      state[kit] > 0 &&
      actionSuccess !== undefined &&
      stateMaximumSuccess - actionSuccess <= context.tolerance + STRICT_EPSILON
    ) {
      eligible.push({
        action,
        edge: transitionNormalized(decoded, kit),
        maximumSuccess: actionSuccess,
      });
    }
  }
  return { actions: eligible, stateMaximumSuccess };
}

function buildEligibleSuccessorClosure(context: SparsePolicyContext): number[] {
  const seen = new Set<number>();
  const queue: number[] = [];
  const add = (state: UsesState) => {
    const key = pack(state);
    if (seen.has(key)) return;
    seen.add(key);
    context.checkBudget(seen.size);
    queue.push(key);
  };
  add(context.start);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    context.checkBudget(seen.size);
    const key = queue[cursor];
    if (key === undefined) throw new Error("Sparse closure cursor exceeded its queue.");
    const state = unpack(key);
    const decoded = decodeState(state.sid);
    if (isTerminalNormalized(decoded)) continue;
    if (isConvertStateNormalized(decoded)) {
      add({ ...state, sid: stateIdNormalized(convertState()) });
      continue;
    }
    const { actions } = potentiallyEligibleActions(context, state, decoded);
    for (const { action, edge } of actions) {
      const nextStock = decrement(state, action);
      add({ ...nextStock, sid: stateIdNormalized(edge.success) });
      add({ ...nextStock, sid: stateIdNormalized(edge.fail) });
    }
  }
  return queue;
}

function improvePolicy(
  context: SparsePolicyContext,
  evaluation: PolicyEvaluation,
  closure: readonly number[],
) {
  const nextOverrides = new Map(context.overrides);
  let changes = 0;
  let successInvariantChecks = 0;
  for (const key of closure) {
    const state = unpack(key);
    const decoded = decodeState(state.sid);
    if (isTerminalNormalized(decoded) || isConvertStateNormalized(decoded)) continue;
    const currentAction = evaluation.actionAt(state);
    const currentValue = evaluation.values.get(key);
    if (!currentValue) throw new Error(`Missing exact policy value for closure state ${key}.`);
    const { actions, stateMaximumSuccess } = potentiallyEligibleActions(context, state, decoded);
    const candidates = actions.map(({ action, edge, maximumSuccess }) => {
      const nextStock = decrement(state, action);
      return {
        action,
        maximumSuccess,
        value: combine(
          edge.probability,
          evaluation.value({ ...nextStock, sid: stateIdNormalized(edge.success) }, false),
          evaluation.value({ ...nextStock, sid: stateIdNormalized(edge.fail) }, false),
        ),
      };
    });
    for (const candidate of candidates) {
      successInvariantChecks += 1;
      if (Math.abs(candidate.maximumSuccess - candidate.value.success) > STRICT_EPSILON) {
        throw new Error(
          `Tau=0 success invariant failed for state ${key} action ${candidate.action}: ` +
            `${candidate.value.success} != ${candidate.maximumSuccess}.`,
        );
      }
    }
    const actuallyEligible = candidates.filter(
      (candidate) =>
        stateMaximumSuccess - candidate.value.success <= context.tolerance + STRICT_EPSILON,
    );
    const pool = actuallyEligible.length > 0 ? actuallyEligible : candidates;
    const first = pool[0];
    if (!first) continue;
    const current = pool.find((candidate) => candidate.action === currentAction);
    let bestAction = current?.action ?? first.action;
    let bestValue = current?.value ?? first.value;
    for (const candidate of pool) {
      if (candidate.action !== bestAction && isBetter(candidate.value, bestValue)) {
        bestAction = candidate.action;
        bestValue = candidate.value;
      }
    }
    if (bestAction === currentAction) continue;
    changes += 1;
    const baseline = context.baselineActionAt(state.sid, state.blue, state.purple, state.yellow);
    if (bestAction === baseline) nextOverrides.delete(key);
    else nextOverrides.set(key, bestAction);
  }
  return { changes, nextOverrides, successInvariantChecks };
}

function actionAtFromOverrides(
  context: SparsePolicyContext,
  overrides: ReadonlyMap<number, number>,
) {
  return (sid: number, blue: number, purple: number, yellow: number) =>
    overrides.get(pack({ sid, blue, purple, yellow })) ??
    context.baselineActionAt(sid, blue, purple, yellow);
}

function nextRunCount(context: SparsePolicyContext, overrides: ReadonlyMap<number, number>) {
  const actionAt = actionAtFromOverrides(context, overrides);
  const actionIndex = actionAt(
    context.start.sid,
    context.start.blue,
    context.start.purple,
    context.start.yellow,
  );
  const action = KIT_ORDER[actionIndex];
  return action ? recommendedRunCount(context.input.start, context.uses, action, actionAt) : 0;
}

function applyOverrides(target: Map<number, number>, source: ReadonlyMap<number, number>) {
  target.clear();
  for (const [key, action] of source) target.set(key, action);
}

function runSparseIterations(context: SparsePolicyContext) {
  let finalValue: SparsePolicyValue | null = null;
  let outcome: SparsePolicyIterationOutcome = "iteration_budget_exceeded";
  let closureStates = 0;
  try {
    const closure = buildEligibleSuccessorClosure(context);
    closureStates = closure.length;
    for (let iteration = 0; iteration < context.maxIterations; iteration += 1) {
      const evaluation = createPolicyEvaluation(context);
      const root = evaluation.value(context.start, true);
      const policyStates = evaluation.reachable.size;
      for (const key of closure) {
        evaluation.value(unpack(key), false);
      }
      if (evaluation.values.size !== closure.length) {
        throw new Error(
          `Policy evaluation escaped the saturated closure: ${evaluation.values.size} != ${closure.length}.`,
        );
      }
      const { changes, nextOverrides, successInvariantChecks } = improvePolicy(
        context,
        evaluation,
        closure,
      );
      if (evaluation.values.size !== closure.length) {
        throw new Error(
          `Policy improvement escaped the saturated closure: ${evaluation.values.size} != ${closure.length}.`,
        );
      }
      const rootAction = evaluation.actionAt(context.start);
      const nextRootAction =
        nextOverrides.get(pack(context.start)) ??
        context.baselineActionAt(
          context.start.sid,
          context.start.blue,
          context.start.purple,
          context.start.yellow,
        );
      finalValue = root;
      context.iterations.push({
        iteration,
        rootAction,
        nextRootAction,
        nextRunCount: nextRunCount(context, nextOverrides),
        rootCost: root.cost,
        rootSuccess: root.success,
        rootTotalUses: root.totalUses,
        policyStates,
        closureStates: closure.length,
        improvementStates: closure.length,
        evaluatedStates: evaluation.values.size,
        successInvariantChecks,
        changes,
        overrides: nextOverrides.size,
      });
      applyOverrides(context.overrides, nextOverrides);
      if (changes === 0) {
        outcome = "completed";
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof SparsePolicyBudgetExceeded)) throw error;
    outcome = error.outcome;
    closureStates = Math.max(closureStates, error.observedStates);
  }
  return { closureStates, finalValue, outcome };
}

function finalPolicyResult(
  context: SparsePolicyContext,
  outcome: SparsePolicyIterationOutcome,
  setupStatus: number,
  finalValue: SparsePolicyValue | null,
  closureStates: number,
  startedAt: number,
): SparsePolicyIterationResult {
  const actionAt = actionAtFromOverrides(context, context.overrides);
  const actionIndex = actionAt(
    context.start.sid,
    context.start.blue,
    context.start.purple,
    context.start.yellow,
  );
  const finalAction = actionIndex >= 0 ? (KIT_ORDER[actionIndex] ?? null) : null;
  const actionSuccesses = finalAction
    ? KIT_ORDER.map((_, action) =>
        context.successForAction(
          context.start.sid,
          context.start.blue,
          context.start.purple,
          context.start.yellow,
          action,
        ),
      )
    : [];
  const maximumSuccess = actionSuccesses.length > 0 ? Math.max(...actionSuccesses) : 0;
  return {
    outcome,
    setupStatus,
    elapsedMs: performance.now() - startedAt,
    iterations: context.iterations,
    finalOverrides: context.overrides.size,
    finalAction,
    finalValue,
    closureStates,
    probabilityGap: Math.max(0, maximumSuccess - (finalValue?.success ?? 0)),
    runCount: finalAction
      ? recommendedRunCount(context.input.start, context.uses, finalAction, actionAt)
      : 0,
  };
}

export function solveSparsePolicyIteration(
  exports: RustCoreExports,
  input: SolverInput,
  options: SparsePolicyIterationOptions = {},
): SparsePolicyIterationResult {
  const config = resolveSparsePolicyConfig(options);
  const startedAt = performance.now();

  exports.configureMemo?.(config.memoTier);
  exports.configureNodeBudget?.(0);
  requireFunction(exports, "solveCore")(
    stateIdNormalized(input.start),
    input.stock.blue | 0,
    input.stock.purple | 0,
    input.stock.yellow | 0,
    EXPECTED_28_DAY_GAIN.blue,
    EXPECTED_28_DAY_GAIN.purple,
    EXPECTED_28_DAY_GAIN.yellow,
    config.horizonFactor,
    config.normPower,
    config.tolerance,
  );
  const setupStatus = exports.getSolveStatus?.() ?? 0;
  if (setupStatus !== 0) {
    return {
      outcome: "phase2_failure",
      setupStatus,
      elapsedMs: performance.now() - startedAt,
      iterations: [],
      finalOverrides: 0,
      finalAction: null,
      finalValue: null,
      closureStates: 0,
      probabilityGap: Number.POSITIVE_INFINITY,
      runCount: 0,
    };
  }
  const context = createSparsePolicyContext(exports, input, config, startedAt);
  const { closureStates, finalValue, outcome } = runSparseIterations(context);
  return finalPolicyResult(context, outcome, setupStatus, finalValue, closureStates, startedAt);
}

export function createSparsePolicyIterationSolver(
  exports: RustCoreExports,
  options: SparsePolicyIterationOptions = {},
) {
  const decisions: SparsePolicyIterationDecision[] = [];
  function solve(input: SolverInput): ExactPolicySolverResult {
    const result = solveSparsePolicyIteration(exports, input, options);
    decisions.push({ input, result });
    if (
      result.outcome !== "completed" &&
      !(options.acceptIterationBudget && result.outcome === "iteration_budget_exceeded")
    ) {
      throw new Error(`Sparse policy iteration did not complete: ${result.outcome}.`);
    }
    if (!result.finalAction || result.runCount <= 0) return { possible: false, best: null };
    return {
      possible: true,
      best: {
        firstAction: result.finalAction,
        probabilityGap: result.probabilityGap,
        run: { count: result.runCount },
      },
    };
  }
  return { decisions, solve };
}
