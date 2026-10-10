import {
  canonicalState,
  cmp,
  independentFailure,
  independentProbability,
  independentSuccess,
  type OracleInput,
  type OracleResult,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import { createIndependentPublicCaps } from "./certified-staging-oracle-public-caps.ts";
import { makeTriple, mapTriple } from "./certified-staging-oracle-tuples.ts";
import { createIndependentUnlimited } from "./certified-staging-oracle-witness.ts";

type State = ReturnType<typeof canonicalState>;
type Numerators = { p: bigint; consumed: readonly [bigint, bigint, bigint]; mask: number };
type Value = Omit<Numerators, "p"> & { p: bigint | undefined };
type LiftedValue = Omit<Numerators, "p"> & { p: bigint | number };
// The ladder stays demand-bounded and its indexed values stay optional.
// These are actual native operation boundaries, not assertions that a missing
// lookup exists. Weighted probabilities and consumption have a definite bigint
// operand, so missing coordinates or a numeric NaN throw natively.
const multiplyPower = ((left: bigint, right: bigint) => left * right) as {
  (left: bigint, right: bigint | number | undefined): bigint;
  (left: bigint | undefined, right: bigint): bigint;
};
// Lifting alone has two optional operands. undefined * undefined produces
// numeric NaN before the consumed-coordinate multiplication throws; model that
// actual intermediate result rather than asserting it is a bigint.
const multiplyLiftedProbability = ((probability: bigint, lift: bigint) => probability * lift) as {
  (probability: undefined, lift: undefined): number;
  (probability: bigint, lift: bigint): bigint;
  (probability: bigint | undefined, lift: bigint | undefined): bigint | number;
};
const powerRemainder = ((power: bigint, divisor: bigint) => power % divisor) as (
  power: bigint | undefined,
  divisor: bigint,
) => bigint;
const powerQuotient = ((power: bigint, divisor: bigint) => power / divisor) as (
  power: bigint | undefined,
  divisor: bigint,
) => bigint;
const decodeProbability = q as {
  (numerator: undefined, denominator: bigint | undefined): never;
  (numerator: bigint | undefined, denominator: bigint | undefined): ReturnType<typeof q>;
};
type RelaxedValue = ReturnType<ReturnType<typeof createIndependentUnlimited>["solve"]>;
type RelaxedAction = RelaxedValue["actions"][number];
type NonterminalRelaxedValue = RelaxedValue & {
  actions: readonly [RelaxedAction, RelaxedAction, RelaxedAction];
};
type Context = {
  powers: readonly bigint[];
  prices: readonly [bigint, bigint, bigint];
  canonicalStock: (state: State, stock: Triple) => Triple;
  common: bigint;
  relaxed: (state: State) => NonterminalRelaxedValue;
};
type Solve = (state: State, stock: Triple) => Value;
const ZERO: Numerators = { p: 0n, consumed: [0n, 0n, 0n], mask: 0 };
const COLORS = ["blue", "purple", "yellow"] as const;
function sum(stock: Triple) {
  return stock[0] + stock[1] + stock[2];
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
function burden(value: Pick<Numerators, "consumed">, prices: readonly [bigint, bigint, bigint]) {
  return value.consumed.reduce(
    (total, pieces, color) => total + pieces * prices[color as 0 | 1 | 2],
    0n,
  );
}
function compare(a: Numerators, b: Numerators, prices: readonly [bigint, bigint, bigint]) {
  if (a.p !== b.p) return a.p > b.p ? 1 : -1;
  const aa = burden(a, prices),
    bb = burden(b, prices);
  if (aa !== bb) return aa < bb ? 1 : -1;
  const first = a.consumed.reduce((total, pieces) => total + pieces, 0n);
  const second = b.consumed.reduce((total, pieces) => total + pieces, 0n);
  if (first === second) return 0;
  return first < second ? 1 : -1;
}
function lifted(
  state: State,
  stock: Triple,
  targetExponent: number,
  context: Context,
  solve: Solve,
): LiftedValue {
  const canonical = context.canonicalStock(state, stock);
  const difference = targetExponent - sum(canonical);
  if (difference < 0) throw new Error("independent_public_cap_denominator_lift_invalid");
  const lift = context.powers[difference];
  const child = solve(state, canonical);
  return {
    p: multiplyLiftedProbability(child.p, lift),
    consumed: mapTriple(child.consumed, (pieces) => multiplyPower(pieces, lift)),
    mask: child.mask,
  };
}
function action(
  state: State,
  stock: Triple,
  color: number,
  context: Context,
  solve: Solve,
): Numerators {
  const remaining = mapTriple(stock, (units, index) => units - (index === color ? 1 : 0));
  const probability = independentProbability(state.grade, state.level, color);
  if (1000n % probability.d !== 0n)
    throw new Error("independent_public_cap_probability_denominator_invalid");
  const good = probability.n * (1000n / probability.d),
    bad = 1000n - good;
  const exponent = sum(remaining);
  const success = good
    ? lifted(independentSuccess(state.grade, state.level), remaining, exponent, context, solve)
    : ZERO;
  const normal = bad
    ? lifted(
        independentFailure(state.grade, state.level, state.exp, color),
        remaining,
        exponent,
        context,
        solve,
      )
    : ZERO;
  return {
    p: multiplyPower(good, success.p) + multiplyPower(bad, normal.p),
    consumed: makeTriple(
      (index) =>
        good * success.consumed[index] +
        bad * normal.consumed[index] +
        (index === color ? multiplyPower(10n, context.powers[exponent + 1]) : 0n),
    ),
    mask: 1 << color,
  };
}
function best(state: State, stock: Triple, context: Context, solve: Solve): Numerators {
  let value = ZERO;
  const relaxed = context.relaxed(state);
  const colors = ([0, 1, 2] satisfies (0 | 1 | 2)[]).sort(
    (first, second) =>
      cmp(relaxed.actions[first].B, relaxed.actions[second].B) ||
      cmp(relaxed.actions[first].C, relaxed.actions[second].C) ||
      first - second,
  );
  for (const color of colors) {
    if (!stock[color]) continue;
    if (strictRelaxedDominance(value, stock, relaxed.actions[color], context)) continue;
    const candidate = action(state, stock, color, context, solve);
    const comparison = compare(candidate, value, context.prices);
    if (comparison > 0) value = candidate;
    else if (comparison === 0) {
      const lowest = [0, 1, 2].find((index) => value.mask & (1 << index)) ?? 3;
      value = { ...(color < lowest ? candidate : value), mask: value.mask | candidate.mask };
    }
  }
  return value;
}
function strictRelaxedDominance(
  value: Numerators,
  stock: Triple,
  relaxed: ReturnType<Context["relaxed"]>["actions"][number],
  context: Context,
) {
  const denominator = context.powers[sum(stock)];
  if (value.p !== denominator) return false;
  const comparison = cmp(relaxed.B, {
    n: burden(value, context.prices),
    d: denominator * context.common,
  });
  return (
    comparison > 0 ||
    (comparison === 0 &&
      cmp(relaxed.C, {
        n: value.consumed.reduce((total, pieces) => total + pieces, 0n),
        d: denominator,
      }) > 0)
  );
}
/** Only a feasible COMPLETE unrestricted policy and all exactly tied root
 * policies can shortcut. Otherwise enumerate finite actions. Strictly worse
 * relaxed actions can be pruned only after an exact finite P=1 incumbent.
 */
function feasibleUnlimited(state: State, stock: Triple, context: Context): Value | null {
  const relaxed = context.relaxed(state);
  const ties = relaxed.actions
    .map((value, color) => ({ value, color }))
    .filter(({ value }) => cmp(value.B, relaxed.B) === 0 && cmp(value.C, relaxed.C) === 0);
  if (
    !ties.every(({ value }) =>
      stock.every((units, color) => units >= value.worst[color as 0 | 1 | 2]),
    )
  )
    return null;
  const denominator = context.powers[sum(stock)];
  const consumed = mapTriple(relaxed.consumed, (pieces) => {
    if (powerRemainder(denominator, pieces.d) !== 0n)
      throw new Error("independent_unlimited_ladder_exact_divisibility_failed");
    return pieces.n * powerQuotient(denominator, pieces.d);
  });
  return {
    p: denominator,
    consumed,
    mask: ties.reduce((bits, { color }) => bits | (1 << color), 0),
  };
}
export function independentLargeCappedOracle(
  input: OracleInput,
  limits: { maxMemoEntries: number; check: (entries: number) => void },
): OracleResult {
  const raw = mapTriple(input.stock, (pieces) => Math.floor(pieces / 10));
  if (sum(raw) > 150) throw new Error("independent_public_cap_admission_max150_initial_uses");
  const publicCaps = createIndependentPublicCaps();
  const initialState = canonicalState(input.grade, input.level, input.exp);
  const units = publicCaps.canonicalStock(initialState, raw);
  const bases = mapTriple(units, (count) => count + 1);
  if (!Number.isSafeInteger(960 * bases[0] * bases[1] * bases[2]))
    throw new Error("independent_public_cap_key_admission_invalid");
  const powers = [1n];
  let power = 1n;
  for (let index = 1; index <= sum(units); index++) {
    power *= 1000n;
    powers.push(power);
  }
  const common = input.prices.reduce(
    (denominator, price) => (denominator / gcd(denominator, price.d)) * price.d,
    1n,
  );
  const prices = mapTriple(input.prices, (price) => price.n * (common / price.d));
  const context: Context = {
    powers,
    prices,
    common,
    canonicalStock: publicCaps.canonicalStock,
    // The producer internally returns either SR15's empty tuple or a dense
    // makeTriple action tuple; its public facade intentionally erases this.
    // Both consumers (feasibleUnlimited and best) are called only after solve's
    // SR15 return below, so this callback boundary excludes the empty shape.
    relaxed: createIndependentUnlimited(input.prices).solve as Context["relaxed"],
  };
  const memo = new Map<number, Numerators>();
  let calls = 0;
  const solve: Solve = (state, stock) => {
    const sid = (state.grade === "R" ? 0 : 480) + state.level * 30 + state.exp / 100;
    const key = ((sid * bases[0] + stock[0]) * bases[1] + stock[1]) * bases[2] + stock[2];
    const cached = memo.get(key);
    if (cached) return cached;
    if (state.grade === "SR" && state.level === 15) return { ...ZERO, p: powers[sum(stock)] };
    const unrestricted = feasibleUnlimited(state, stock, context);
    if (unrestricted) return unrestricted;
    if (memo.size >= limits.maxMemoEntries)
      throw new Error("independent_public_cap_memo_admission_limit");
    if ((calls++ & 4095) === 0) limits.check(memo.size);
    const result = best(state, stock, context, solve);
    memo.set(key, result);
    return result;
  };
  const value = solve(initialState, units);
  limits.check(memo.size);
  const denominator = powers[sum(units)];
  const terminal = initialState.grade === "SR" && initialState.level === 15;
  const ties = COLORS.filter((_color, index) => (value.mask & (1 << index)) !== 0);
  const inactiveAction = terminal ? "DONE" : "STOP";
  return {
    P: decodeProbability(value.p, denominator),
    B: q(burden(value, prices), multiplyPower(denominator, common)),
    C: q(
      value.consumed.reduce((total, pieces) => total + pieces, 0n),
      denominator,
    ),
    consumed: mapTriple(value.consumed, (pieces) => q(pieces, denominator)),
    action: ties[0] ?? inactiveAction,
    ties: ties.length ? ties : [inactiveAction],
    candidates: new Map(),
    nodes: memo.size,
  };
}
