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

/** Independent uncapped inventory DP derived from public probabilities. No candidate imports. */
type State = ReturnType<typeof canonicalState>;
type Numerators = {
  p: bigint;
  consumed: readonly [bigint, bigint, bigint];
  burden: bigint;
  total: bigint;
  action: OracleResult["action"];
  ties: OracleResult["ties"];
};
// Only the terminal endpoint can expose a missing ladder coordinate.
type Value = Omit<Numerators, "p"> & { p: bigint | undefined };
type Recurse = (grade: OracleInput["grade"], level: number, exp: number, stock: Triple) => Value;
// A demand-bounded ladder lookup can be missing on malformed stock. Preserve
// that value until the original native operator or q decoder consumes it.
// Each multiplication has one definite bigint operand. Missing coordinates
// therefore throw natively, unlike undefined * undefined (which yields NaN).
const multiplyPower = ((left: bigint, right: bigint) => left * right) as {
  (left: bigint, right: bigint | undefined): bigint;
  (left: bigint | undefined, right: bigint): bigint;
};
const decodeProbability = q as {
  (numerator: undefined, denominator: bigint | undefined): never;
  (numerator: bigint | undefined, denominator: bigint | undefined): ReturnType<typeof q>;
};
const colors = ["blue", "purple", "yellow"] as const;
const empty = (): Numerators => ({
  p: 0n,
  consumed: [0n, 0n, 0n],
  burden: 0n,
  total: 0n,
  action: "STOP",
  ties: ["STOP"],
});
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
function compare(candidate: Numerators, best: Numerators): number {
  if (candidate.p !== best.p) return candidate.p > best.p ? 1 : -1;
  if (candidate.burden !== best.burden) return candidate.burden < best.burden ? 1 : -1;
  if (candidate.total !== best.total) return candidate.total < best.total ? 1 : -1;
  return 0;
}
function actionValue(
  state: State,
  stock: Triple,
  color: 0 | 1 | 2,
  denominator: bigint | undefined,
  prices: readonly [bigint, bigint, bigint],
  solve: Recurse,
): Numerators {
  const nextStock = mapTriple(stock, (count, index) => count - (index === color ? 1 : 0));
  const p = independentProbability(state.grade, state.level, color);
  const successWeight = p.n * (1000n / p.d);
  const failureWeight = 1000n - successWeight;
  const great = independentSuccess(state.grade, state.level);
  const normal = independentFailure(state.grade, state.level, state.exp, color);
  const g = successWeight ? solve(great.grade, great.level, great.exp, nextStock) : empty();
  const n = failureWeight ? solve(normal.grade, normal.level, normal.exp, nextStock) : empty();
  const consumed = makeTriple(
    (index) =>
      successWeight * g.consumed[index] +
      failureWeight * n.consumed[index] +
      (index === color ? multiplyPower(10n, denominator) : 0n),
  );
  return {
    p: multiplyPower(successWeight, g.p) + multiplyPower(failureWeight, n.p),
    consumed,
    burden: consumed.reduce((sum, amount, index) => sum + amount * prices[index as 0 | 1 | 2], 0n),
    total: consumed.reduce((sum, amount) => sum + amount, 0n),
    action: colors[color],
    ties: [colors[color]],
  };
}
function bestActions(
  state: State,
  stock: Triple,
  denominator: bigint | undefined,
  prices: readonly [bigint, bigint, bigint],
  solve: Recurse,
): Numerators {
  let best = empty();
  for (const color of [0, 1, 2] as const) {
    if (!stock[color]) continue;
    const candidate = actionValue(state, stock, color, denominator, prices, solve);
    const comparison = compare(candidate, best);
    if (comparison > 0) best = candidate;
    else if (comparison === 0) best = { ...best, ties: [...best.ties, colors[color]] };
  }
  return best;
}
export function solveIntegerOracle(input: OracleInput): OracleResult {
  const units = mapTriple(input.stock, (pieces) => Math.floor(pieces / 10));
  const totalUnits = units.reduce((sum, count) => sum + count, 0);
  if (totalUnits > 30) throw new Error("Original uncapped oracle contract permits at most30 uses");
  const powers = [1n];
  let power = 1n;
  for (let index = 1; index <= totalUnits; index += 1) {
    power *= 1000n;
    powers.push(power);
  }
  const common = input.prices.reduce(
    (denominator, price) => (denominator / gcd(denominator, price.d)) * price.d,
    1n,
  );
  const prices = mapTriple(input.prices, (price) => price.n * (common / price.d));
  const memo = new Map<string, Numerators>();
  const solve: Recurse = (rawGrade, rawLevel, rawExp, stock) => {
    const state = canonicalState(rawGrade, rawLevel, rawExp);
    const key = [state.grade, state.level, state.exp, ...stock].join(":");
    const cached = memo.get(key);
    if (cached) return cached;
    const denominator = powers[stock.reduce((sum, count) => sum + count, 0)];
    if (state.grade === "SR" && state.level >= 15)
      return { ...empty(), p: denominator, action: "DONE", ties: ["DONE"] };
    const best = bestActions(state, stock, denominator, prices, solve);
    memo.set(key, best);
    return best;
  };
  const value = solve(input.grade, input.level, input.exp, units);
  const denominator = powers[totalUnits];
  return {
    P: decodeProbability(value.p, denominator),
    B: q(value.burden, multiplyPower(denominator, common)),
    C: q(value.total, denominator),
    consumed: mapTriple(value.consumed, (amount) => q(amount, denominator)),
    action: value.action,
    ties: value.ties,
    candidates: new Map(),
    nodes: memo.size,
  };
}
