import type { CollectionState, Kit, KitVector } from "./domain";
import {
  convertState,
  decrementStock,
  isConvertStateNormalized,
  isTerminalNormalized,
  normalizeState,
  stateIdNormalized,
  stateText,
  transitionNormalized,
} from "./domain";
import type { NormalizedSolverInput } from "./input";

export type ActionFor = (state: Partial<CollectionState>, stock: KitVector) => Kit | null;

export type FailureRouteStep = {
  state: string;
  kit: Kit | "convert";
  probability: number;
  success: string;
  fail: string;
  stockBefore: KitVector;
};

export type RecommendedRun = {
  kit: Kit;
  count: number;
  success: CollectionState;
  fail: CollectionState;
  greatSuccessProbability: number;
  noGreatSuccessProbability: number;
};

export function buildFailureRoute(
  input: NormalizedSolverInput,
  actionFor: ActionFor,
  limit = 8,
): FailureRouteStep[] {
  const route: FailureRouteStep[] = [];
  let state = normalizeState(input.start);
  let stock = { ...input.stockUses };

  for (let index = 0; index < limit; index += 1) {
    if (isTerminalNormalized(state)) break;
    if (isConvertStateNormalized(state)) {
      route.push({
        state: stateText(state),
        kit: "convert",
        probability: 1,
        success: stateText(convertState()),
        fail: stateText(convertState()),
        stockBefore: { ...stock },
      });
      state = convertState();
      continue;
    }
    const kit = actionFor(state, stock);
    if (!kit || stock[kit] <= 0) break;
    const edge = transitionNormalized(state, kit);
    route.push({
      state: stateText(state),
      kit,
      probability: edge.probability,
      success: stateText(edge.success),
      fail: stateText(edge.fail),
      stockBefore: { ...stock },
    });
    stock = decrementStock(stock, kit);
    state = edge.fail;
  }

  return route;
}

export function buildRecommendedRun(
  input: NormalizedSolverInput,
  actionFor: ActionFor,
  limit = 100,
) {
  const kit = actionFor(normalizeState(input.start), { ...input.stockUses });
  return buildRecommendedRunForKit(input, actionFor, kit, limit);
}

export function buildRecommendedRunForKit(
  input: NormalizedSolverInput,
  actionFor: ActionFor,
  kit: Kit | null,
  limit = 100,
): RecommendedRun | null {
  let state = normalizeState(input.start);
  let stock = { ...input.stockUses };
  if (!kit || stock[kit] <= 0) return null;

  const firstEdge = transitionNormalized(state, kit);
  const successTarget = firstEdge.success;
  let count = 0;
  let noGreatSuccessProbability = 1;

  while (
    count < limit &&
    !isTerminalNormalized(state) &&
    !isConvertStateNormalized(state) &&
    stock[kit] > 0
  ) {
    if (count > 0) {
      const nextKit = actionFor(state, stock);
      if (nextKit !== kit) break;
    }
    const edge = transitionNormalized(state, kit);
    if (stateIdNormalized(edge.success) !== stateIdNormalized(successTarget)) break;
    count += 1;
    noGreatSuccessProbability *= 1 - edge.probability;
    stock = decrementStock(stock, kit);
    const fail = edge.fail;
    const leveledUp = fail.grade !== state.grade || fail.level !== state.level;
    state = fail;
    if (leveledUp) break;
  }

  return {
    kit,
    count,
    success: successTarget,
    fail: state,
    greatSuccessProbability: 1 - noGreatSuccessProbability,
    noGreatSuccessProbability,
  };
}
