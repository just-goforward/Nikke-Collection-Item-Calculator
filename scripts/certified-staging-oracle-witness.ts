import {
  add,
  canonicalState,
  cmp,
  compareValue,
  type ExactQ,
  independentFailure,
  independentProbability,
  independentSuccess,
  mul,
  type OracleInput,
  type OracleValue,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import { makeTriple } from "./certified-staging-oracle-tuples.ts";

type State = Pick<OracleInput, "grade" | "level" | "exp">;
type PolicyValue = { B: ExactQ; C: ExactQ; consumed: QTriple };
type RelaxedAction = PolicyValue & { worst: Triple };
type UnlimitedValue = RelaxedAction & { actions: readonly RelaxedAction[] };
const ZERO = q(0);

function mixed(probability: ExactQ, success: PolicyValue, normal: PolicyValue): PolicyValue {
  const other = q(probability.d - probability.n, probability.d);
  return {
    B: add(mul(probability, success.B), mul(other, normal.B)),
    C: add(mul(probability, success.C), mul(other, normal.C)),
    consumed: makeTriple((color) =>
      add(mul(probability, success.consumed[color]), mul(other, normal.consumed[color])),
    ),
  };
}
function descendants(state: State, color: number): readonly [State, State] {
  return [
    independentSuccess(state.grade, state.level),
    independentFailure(state.grade, state.level, state.exp, color),
  ];
}
function stateKey(state: State): string {
  return [state.grade, state.level, state.exp].join(":");
}
function actionValue(
  state: State,
  color: 0 | 1 | 2,
  prices: QTriple,
  solve: (state: State) => UnlimitedValue,
): RelaxedAction {
  const [success, normal] = descendants(state, color);
  const successValue = solve(success);
  const normalValue = solve(normal);
  const probability = independentProbability(state.grade, state.level, color);
  const value = mixed(probability, successValue, normalValue);
  return {
    B: add(mul(q(10), prices[color]), value.B),
    C: add(q(10), value.C),
    consumed: makeTriple((index) => add(value.consumed[index], q(index === color ? 10 : 0))),
    worst: makeTriple(
      (index) =>
        Math.max(
          probability.n > 0n ? successValue.worst[index] : 0,
          probability.n < probability.d ? normalValue.worst[index] : 0,
        ) + (index === color ? 1 : 0),
    ),
  };
}

/** No inventory caps or candidate transitions: finite game-state DAG with unlimited stock. */
export function createIndependentUnlimited(prices: QTriple) {
  const memo = new Map<string, UnlimitedValue>();
  const solve = (raw: State): UnlimitedValue => {
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    const key = stateKey(state);
    const cached = memo.get(key);
    if (cached) return cached;
    if (state.grade === "SR" && state.level === 15)
      return { B: ZERO, C: ZERO, consumed: [ZERO, ZERO, ZERO], worst: [0, 0, 0], actions: [] };
    const actions = makeTriple((color) => actionValue(state, color, prices, solve));
    let best = actions[0];
    for (const action of actions.slice(1)) {
      const burden = cmp(action.B, best.B);
      if (burden < 0 || (burden === 0 && cmp(action.C, best.C) < 0)) best = action;
    }
    const result = { ...best, actions };
    memo.set(key, result);
    return result;
  };
  return { solve, nodes: () => memo.size };
}

export function maximumBlueUses(raw: State): number {
  const memo = new Map<string, number>();
  const solve = (state: State): number => {
    if (state.grade === "SR" && state.level === 15) return 0;
    const key = stateKey(state);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const [success, normal] = descendants(state, 0);
    const probability = independentProbability(state.grade, state.level, 0);
    const longest =
      Math.max(
        probability.n > 0n ? solve(success) : 0,
        probability.n < probability.d ? solve(normal) : 0,
      ) + 1;
    memo.set(key, longest);
    return longest;
  };
  return solve(canonicalState(raw.grade, raw.level, raw.exp));
}

export function blueReachableStates(raw: State): readonly State[] {
  const pending: State[] = [canonicalState(raw.grade, raw.level, raw.exp)];
  const seen = new Map<string, State>();
  for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
    const key = stateKey(state);
    if (seen.has(key) || (state.grade === "SR" && state.level === 15)) continue;
    seen.set(key, state);
    pending.push(...descendants(state, 0));
  }
  return [...seen.values()];
}

type FiniteValue = OracleValue & { consumed: QTriple };
function finiteMix(probability: ExactQ, success: FiniteValue, normal: FiniteValue): FiniteValue {
  const value = mixed(probability, success, normal);
  const other = q(probability.d - probability.n, probability.d);
  return { ...value, P: add(mul(probability, success.P), mul(other, normal.P)) };
}
function finiteAction(
  state: State,
  stock: Triple,
  color: 0 | 1 | 2,
  prices: QTriple,
  solve: (state: State, stock: Triple) => FiniteValue,
): FiniteValue {
  const reduced = makeTriple((index) => stock[index] - (index === color ? 10 : 0));
  const [success, normal] = descendants(state, color);
  const value = finiteMix(
    independentProbability(state.grade, state.level, color),
    solve(success, reduced),
    solve(normal, reduced),
  );
  return {
    P: value.P,
    B: add(value.B, mul(q(10), prices[color])),
    C: add(value.C, q(10)),
    consumed: makeTriple((index) => add(value.consumed[index], q(index === color ? 10 : 0))),
  };
}
function feasibleRelaxation(stock: Triple, value: UnlimitedValue): boolean {
  return stock.every((pieces, color) => pieces >= value.worst[color]! * 10);
}
/** Independent uncapped Bellman inventory DP for the one-shortage witness.
 * A feasible relaxation requires its complete worst-path stock bound.
 * Pruning requires an exact P=1 incumbent and strict unlimited dominance.
 */
export function independentFiniteWitness(
  input: OracleInput,
  budget: { maxMemoEntries?: number; deadlineAt?: number } = {},
) {
  const unlimited = createIndependentUnlimited(input.prices);
  const memo = new Map<string, FiniteValue>();
  const solve = (raw: State, stock: Triple): FiniteValue => {
    if (budget.deadlineAt !== undefined && performance.now() >= budget.deadlineAt)
      throw new Error("independent_endpoint_time_budget");
    if (budget.maxMemoEntries !== undefined && memo.size >= budget.maxMemoEntries)
      throw new Error("independent_endpoint_memo_budget");
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    const key = `${stateKey(state)}:${stock.join(",")}`;
    const cached = memo.get(key);
    if (cached) return cached;
    if (state.grade === "SR" && state.level === 15)
      return { P: q(1), B: ZERO, C: ZERO, consumed: [ZERO, ZERO, ZERO] };
    const relaxed = unlimited.solve(state);
    if (feasibleRelaxation(stock, relaxed)) return { ...relaxed, P: q(1) };
    let best: FiniteValue = { P: ZERO, B: ZERO, C: ZERO, consumed: [ZERO, ZERO, ZERO] };
    let selected = 3;
    const colors = ([0, 1, 2] as const)
      .filter((color) => stock[color] >= 10)
      .sort((a, b) => cmp(relaxed.actions[a]!.B, relaxed.actions[b]!.B) || a - b);
    for (const color of colors) {
      if (
        cmp(best.P, q(1)) === 0 &&
        compareValue({ ...relaxed.actions[color]!, P: q(1) }, best) < 0
      )
        continue;
      const value = finiteAction(state, stock, color, input.prices, solve);
      const comparison = compareValue(value, best);
      if (comparison > 0 || (comparison === 0 && color < selected)) {
        best = value;
        selected = color;
      }
    }
    memo.set(key, best);
    return best;
  };
  return { ...solve(input, input.stock), nodes: memo.size, unlimitedNodes: unlimited.nodes() };
}

function choose(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  for (let index = 1; index <= k; index++)
    result = (result * BigInt(n - index + 1)) / BigInt(index);
  return result;
}
function power(value: ExactQ, exponent: number): ExactQ {
  return q(value.n ** BigInt(exponent), value.d ** BigInt(exponent));
}
export function independentBoxMass(
  law: "regular-box-v1" | "box-ii-v1",
  count: number,
  pieces: Triple,
): ExactQ {
  if (pieces.some((value) => value < 0)) return ZERO;
  if (law === "regular-box-v1") {
    const blue = pieces[0] / 3;
    const purple = pieces[1];
    if (!Number.isInteger(blue) || pieces[2] !== 0 || blue + purple !== count) return ZERO;
    return mul(q(choose(count, blue)), mul(power(q(4, 5), blue), power(q(1, 5), purple)));
  }
  const [blue, purple, yellow] = [pieces[0] / 5, pieces[1] / 2, pieces[2] / 2];
  if (![blue, purple, yellow].every(Number.isInteger) || blue + purple + yellow !== count)
    return ZERO;
  const combinations = choose(count, blue) * choose(count - blue, purple);
  return mul(
    q(combinations),
    mul(power(q(7, 10), blue), mul(power(q(1, 5), purple), power(q(1, 10), yellow))),
  );
}

// Four physical cards per class, four draws; cohort0 never refreshes.
const WEIGHTS = [15, 15, 6, 3, 4, 2, 15, 8, 8, 4, 3, 7, 7, 3] as const;
type Board = { counts: readonly number[]; mass: ExactQ };
let boards: readonly Board[] | null = null;
function independentZeroCohortBoards(): readonly Board[] {
  if (boards) return boards;
  const distribution = new Map<string, Board>();
  const counts = WEIGHTS.map(() => 0);
  const draw = (remaining: number, mass: ExactQ) => {
    if (remaining === 0) {
      const key = counts.join(",");
      const existing = distribution.get(key);
      distribution.set(key, {
        counts: [...counts],
        mass: existing ? add(existing.mass, mass) : mass,
      });
      return;
    }
    const total = WEIGHTS.reduce((sum, weight, index) => sum + (4 - counts[index]!) * weight, 0);
    for (let index = 0; index < WEIGHTS.length; index++) {
      const weight = (4 - counts[index]!) * WEIGHTS[index]!;
      if (weight === 0) continue;
      counts[index] = counts[index]! + 1;
      draw(remaining - 1, mul(mass, q(weight, total)));
      counts[index] = counts[index]! - 1;
    }
  };
  draw(4, q(1));
  boards = [...distribution.values()];
  return boards;
}
function boardDirect(counts: readonly number[]): Triple {
  return [
    counts[0]! * 2 + counts[1]! * 3,
    counts[2]! * 2 + counts[3]! * 3,
    counts[4]! + counts[5]! * 2,
  ];
}
function conditionalBoardMass(counts: readonly number[], target: Triple): ExactQ {
  const direct = boardDirect(counts);
  const regular = counts[6]! + counts[7]! * 2;
  const second = counts[8]! + counts[9]! * 2;
  let mass = ZERO;
  for (let blue = 0; blue <= regular; blue++) {
    const first: Triple = [blue * 3, regular - blue, 0];
    const rest: Triple = [
      target[0] - direct[0] - first[0],
      target[1] - direct[1] - first[1],
      target[2] - direct[2],
    ];
    mass = add(
      mass,
      mul(
        independentBoxMass("regular-box-v1", regular, first),
        independentBoxMass("box-ii-v1", second, rest),
      ),
    );
  }
  return mass;
}
export function independentDispatchZeroMass(target: Triple): ExactQ {
  return independentZeroCohortBoards().reduce(
    (mass, board) => add(mass, mul(board.mass, conditionalBoardMass(board.counts, target))),
    ZERO,
  );
}
