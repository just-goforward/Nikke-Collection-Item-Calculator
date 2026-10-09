import {
  canonicalState,
  independentFailure,
  independentProbability,
  independentSuccess,
  type OracleInput,
  type OracleResult,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import { makeTriple, mapTriple } from "./certified-staging-oracle-tuples.ts";

type State = ReturnType<typeof canonicalState>;
type Value = { p: bigint; consumed: readonly [bigint, bigint, bigint]; mask: number };
type Limits = { maxMemoEntries: number; check: (entries: number) => void };
const ZERO: Value = { p: 0n, consumed: [0n, 0n, 0n], mask: 0 };
const COLORS = ["blue", "purple", "yellow"] as const;
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
function burden(value: Value, prices: readonly bigint[]): bigint {
  return value.consumed.reduce((sum, pieces, color) => sum + pieces * BigInt(prices[color]!), 0n);
}
function total(value: Value): bigint {
  return value.consumed[0] + value.consumed[1] + value.consumed[2];
}
function compare(a: Value, b: Value, prices: readonly bigint[]): number {
  if (a.p !== b.p) return a.p > b.p ? 1 : -1;
  const first = burden(a, prices),
    second = burden(b, prices);
  if (first !== second) return first < second ? 1 : -1;
  const aa = total(a),
    bb = total(b);
  if (aa === bb) return 0;
  return aa < bb ? 1 : -1;
}
type Solve = (state: State, stock: Triple) => Value;
function action(
  state: State,
  stock: Triple,
  color: number,
  denominator: bigint,
  solve: Solve,
): Value {
  const remaining = mapTriple(stock, (count, index) => count - (index === color ? 1 : 0));
  const probability = independentProbability(state.grade, state.level, color);
  if (1000n % probability.d !== 0n)
    throw new Error("large_oracle_probability_denominator_not_divisor1000");
  const good = probability.n * (1000n / probability.d),
    bad = 1000n - good;
  const success =
    good === 0n ? ZERO : solve(independentSuccess(state.grade, state.level), remaining);
  const normal =
    bad === 0n
      ? ZERO
      : solve(independentFailure(state.grade, state.level, state.exp, color), remaining);
  return {
    p: good * success.p + bad * normal.p,
    consumed: makeTriple(
      (index) =>
        good * success.consumed[index] +
        bad * normal.consumed[index] +
        (index === color ? 10n * denominator : 0n),
    ),
    mask: 1 << color,
  };
}
function best(
  state: State,
  stock: Triple,
  denominator: bigint,
  prices: readonly bigint[],
  solve: Solve,
): Value {
  let value = ZERO;
  for (let color = 0; color < 3; color++) {
    if (stock[color] === 0) continue;
    const candidate = action(state, stock, color, denominator, solve);
    const comparison = compare(candidate, value, prices);
    if (comparison > 0) value = candidate;
    else if (comparison === 0) value = { ...value, mask: value.mask | candidate.mask };
  }
  return value;
}
/** Expanded independent oracle. No stock capping, relaxed pruning, candidate
 * transitions, or candidate imports. Admission guards only abort with NOTRUN.
 * Numeric keys are an injective mixed radix over the original inventory box.
 */
export function independentLargeIntegerOracle(input: OracleInput, limits: Limits): OracleResult {
  const units = mapTriple(input.stock, (pieces) => Math.floor(pieces / 10));
  const sum = units.reduce((n, value) => n + value, 0);
  if (sum > 150) throw new Error("large_oracle_admission_max150_initial_uses");
  const bases = mapTriple(units, (value) => value + 1);
  if (!Number.isSafeInteger(960 * bases[0] * bases[1] * bases[2]))
    throw new Error("large_oracle_noninjective_numeric_key_admission");
  const powers = [1n];
  let power = 1n;
  for (let exponent = 1; exponent <= sum; exponent++) {
    power *= 1000n;
    powers.push(power);
  }
  const common = input.prices.reduce((d, price) => (d / gcd(d, price.d)) * price.d, 1n);
  const prices = mapTriple(input.prices, (price) => price.n * (common / price.d));
  const memo = new Map<number, Value>();
  let calls = 0;
  const solve: Solve = (raw, stock) => {
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    const sid = (state.grade === "R" ? 0 : 480) + state.level * 30 + state.exp / 100;
    const key = ((sid * bases[0] + stock[0]) * bases[1] + stock[1]) * bases[2] + stock[2];
    const found = memo.get(key);
    if (found) return found;
    const denominator = powers[stock[0] + stock[1] + stock[2]]!;
    if (state.grade === "SR" && state.level === 15) return { ...ZERO, p: denominator };
    if (memo.size >= limits.maxMemoEntries) throw new Error("large_oracle_memo_admission_limit");
    if ((calls++ & 4095) === 0) limits.check(memo.size);
    const value = best(state, stock, denominator, prices, solve);
    memo.set(key, value);
    return value;
  };
  const value = solve(canonicalState(input.grade, input.level, input.exp), units);
  limits.check(memo.size);
  const denominator = powers[sum]!;
  const terminal = input.grade === "SR" && input.level === 15;
  const ties = COLORS.filter((_color, index) => (value.mask & (1 << index)) !== 0);
  const inactiveAction = terminal ? "DONE" : "STOP";
  return {
    P: q(value.p, denominator),
    B: q(burden(value, prices), denominator * common),
    C: q(total(value), denominator),
    consumed: mapTriple(value.consumed, (pieces) => q(pieces, denominator)),
    action: ties[0] ?? inactiveAction,
    ties: ties.length ? ties : [inactiveAction],
    candidates: new Map(),
    nodes: memo.size,
  };
}
