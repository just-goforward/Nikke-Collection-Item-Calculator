import {
  canonicalState,
  cmp,
  independentFailure,
  independentProbability,
  independentSuccess,
  makeTriple,
  type OracleInput,
  type OracleValue,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import { createIndependentUnlimited } from "./certified-staging-oracle-witness.ts";

type State = Pick<OracleInput, "grade" | "level" | "exp">;
type Numerators = { P: bigint; consumed: readonly [bigint, bigint, bigint] };
type Budget = { maxMemoEntries?: number; deadlineAt?: number };
type Unlimited = ReturnType<ReturnType<typeof createIndependentUnlimited>["solve"]>;
type Context = {
  priceDenominator: bigint;
  priceNumerators: readonly [bigint, bigint, bigint];
  powers: bigint[];
  unlimited: ReturnType<typeof createIndependentUnlimited>;
  memo: Map<string, Numerators>;
  budget: Budget;
};
const ZERO: Numerators = { P: 0n, consumed: [0n, 0n, 0n] };

function gcd(first: bigint, second: bigint): bigint {
  while (second !== 0n) [first, second] = [second, first % second];
  return first;
}
function priceScale(prices: QTriple) {
  const denominator = prices.reduce((value, price) => (value / gcd(value, price.d)) * price.d, 1n);
  const numerators = makeTriple((color) => prices[color]!.n * (denominator / prices[color]!.d));
  return { denominator, numerators };
}
function stockUnits(stock: Triple): number {
  return stock.reduce((sum, pieces) => sum + Math.floor(pieces / 10), 0);
}
function payloadGuard(context: Context) {
  if (context.budget.deadlineAt !== undefined && performance.now() >= context.budget.deadlineAt)
    throw new Error("independent_endpoint_time_budget");
  if (
    context.budget.maxMemoEntries !== undefined &&
    context.memo.size >= context.budget.maxMemoEntries
  )
    throw new Error("independent_endpoint_memo_budget");
}
function burden(context: Context, value: Numerators): bigint {
  return value.consumed.reduce(
    (sum, pieces, color) => sum + pieces * context.priceNumerators[color]!,
    0n,
  );
}
function total(value: Numerators): bigint {
  return value.consumed[0] + value.consumed[1] + value.consumed[2];
}
function compare(context: Context, first: Numerators, second: Numerators): number {
  if (first.P !== second.P) return first.P > second.P ? 1 : -1;
  const firstB = burden(context, first),
    secondB = burden(context, second);
  if (firstB !== secondB) return firstB < secondB ? 1 : -1;
  const firstC = total(first),
    secondC = total(second);
  return firstC === secondC ? 0 : firstC < secondC ? 1 : -1;
}
function feasible(stock: Triple, value: Unlimited): boolean {
  return stock.every((pieces, color) => pieces >= value.worst[color]! * 10);
}
function convertFeasible(value: Unlimited, denominator: bigint): Numerators {
  const consumed = makeTriple((color) => {
    const amount = value.consumed[color]!;
    if (denominator % amount.d !== 0n)
      throw new Error("independent_endpoint_feasible_denominator_invariant");
    return amount.n * (denominator / amount.d);
  });
  return { P: denominator, consumed };
}
function strictlyDominated(
  context: Context,
  action: Unlimited["actions"][number],
  incumbent: Numerators,
  denominator: bigint,
): boolean {
  if (incumbent.P !== denominator) return false;
  const leftB = action.B.n * context.priceDenominator * denominator;
  const rightB = burden(context, incumbent) * action.B.d;
  if (leftB !== rightB) return leftB > rightB;
  return action.C.n * denominator > total(incumbent) * action.C.d;
}
function perMille(state: State, color: number): bigint {
  const probability = independentProbability(state.grade, state.level, color);
  if ((probability.n * 1000n) % probability.d !== 0n)
    throw new Error("independent_endpoint_public_probability_not_per_mille");
  return (probability.n * 1000n) / probability.d;
}
function action(
  context: Context,
  state: State,
  stock: Triple,
  color: number,
  denominator: bigint,
): Numerators {
  const remaining = makeTriple((index) => stock[index]! - (index === color ? 10 : 0));
  const probability = perMille(state, color);
  const great =
    probability === 0n
      ? ZERO
      : solve(context, independentSuccess(state.grade, state.level), remaining);
  const normal =
    probability === 1000n
      ? ZERO
      : solve(context, independentFailure(state.grade, state.level, state.exp, color), remaining);
  return {
    P: probability * great.P + (1000n - probability) * normal.P,
    consumed: makeTriple(
      (index) =>
        probability * great.consumed[index]! +
        (1000n - probability) * normal.consumed[index]! +
        (index === color ? 10n * denominator : 0n),
    ),
  };
}
function choose(
  context: Context,
  state: State,
  stock: Triple,
  relaxed: Unlimited,
  denominator: bigint,
) {
  const colors = [0, 1, 2]
    .filter((color) => stock[color]! >= 10)
    .sort(
      (first, second) =>
        cmp(relaxed.actions[first]!.B, relaxed.actions[second]!.B) || first - second,
    );
  let best = ZERO,
    selected = 3;
  for (const color of colors) {
    if (strictlyDominated(context, relaxed.actions[color]!, best, denominator)) continue;
    const value = action(context, state, stock, color, denominator);
    const order = compare(context, value, best);
    if (order > 0 || (order === 0 && color < selected)) {
      best = value;
      selected = color;
    }
  }
  return best;
}
function solve(context: Context, raw: State, stock: Triple): Numerators {
  payloadGuard(context);
  const state = canonicalState(raw.grade, raw.level, raw.exp);
  const key = [state.grade, state.level, state.exp, ...stock].join(":");
  const cached = context.memo.get(key);
  if (cached) return cached;
  const denominator = context.powers[stockUnits(stock)]!;
  if (state.grade === "SR" && state.level === 15) return { P: denominator, consumed: [0n, 0n, 0n] };
  const relaxed = context.unlimited.solve(state);
  if (feasible(stock, relaxed)) return convertFeasible(relaxed, denominator);
  const result = choose(context, state, stock, relaxed, denominator);
  context.memo.set(key, result);
  return result;
}

/** Independent uncapped inventory recurrence, with denominator D(stock)=1000^sum(floor(stock/10)).
 * Every public action consumes one unit, so both positive successors use D/1000.
 * Thus the per-mille mixture requires no rounding or inferred game-state cap.
 * Terminal probability is lifted to its retained-stock denominator, not denominator1.
 * A shortcut requires complete per-color worst-path feasibility of an independently solved
 * unrestricted public DAG. It does not assume that an unrestricted value is attainable.
 * Strict pruning needs a finite P1 incumbent and an exact unrestricted B/C lower bound.
 * Raw remainders remain in the uncapped memo identity; all ties retain deterministic color order.
 */
function admit(context: Context, stock: Triple): number {
  const units = stockUnits(stock);
  if (stock.some((pieces) => !Number.isSafeInteger(pieces) || pieces < 0) || units > 600)
    throw new Error("independent_endpoint_integer_power_admission");
  for (let use = context.powers.length; use <= units; use++)
    context.powers.push(context.powers[use - 1]! * 1000n);
  return units;
}
function publicValue(context: Context, input: State & { stock: Triple }) {
  const units = admit(context, input.stock);
  const value = solve(context, input, input.stock),
    denominator = context.powers[units]!;
  if (context.budget.deadlineAt !== undefined && performance.now() >= context.budget.deadlineAt)
    throw new Error("independent_endpoint_time_budget");
  const result: OracleValue & { consumed: QTriple; nodes: number; unlimitedNodes: number } = {
    P: q(value.P, denominator),
    B: q(burden(context, value), context.priceDenominator * denominator),
    C: q(total(value), denominator),
    consumed: makeTriple((color) => q(value.consumed[color]!, denominator)),
    nodes: context.memo.size,
    unlimitedNodes: context.unlimited.nodes(),
  };
  return result;
}
export function createIndependentEndpointIntegerEvaluator(prices: QTriple, budget: Budget = {}) {
  const scale = priceScale(prices);
  const context: Context = {
    priceDenominator: scale.denominator,
    priceNumerators: scale.numerators,
    powers: [1n],
    unlimited: createIndependentUnlimited(prices),
    memo: new Map(),
    budget,
  };
  return (input: State & { stock: Triple }) => publicValue(context, input);
}
export function independentFiniteWitnessInteger(input: OracleInput, budget: Budget = {}) {
  return createIndependentEndpointIntegerEvaluator(input.prices, budget)(input);
}
