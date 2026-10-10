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
type Edge = { good: bigint; bad: bigint; success: number; normal: number };
type EdgeRow = readonly Edge[];
// Both array coordinates may be missing. Only the native property access
// on a missing outer row throws here; an absent inner edge stays undefined.
const edgeAt = ((row: EdgeRow, color: number) => row[color]) as {
  (row: undefined, color: number): never;
  (row: EdgeRow | undefined, color: number): Edge | undefined;
};
const edgeProperty = ((edge: Partial<Edge>, key: keyof Edge) => edge[key]) as {
  (edge: undefined, key: keyof Edge): never;
  (edge: Edge | undefined, key: "good" | "bad"): bigint;
  (edge: Edge | undefined, key: "success" | "normal"): number;
};
const multiplyPrice = ((pieces: bigint, price: bigint) => pieces * price) as {
  (pieces: bigint, price: undefined): never;
  (pieces: bigint, price: bigint | undefined): bigint;
};
type Value = {
  p: bigint;
  consumed: readonly [bigint, bigint, bigint];
  B: bigint;
  C: bigint;
  mask: number;
};
type Limits = { maxMemoEntries: number; check: (live: number, cumulative?: number) => void };
const ZERO: Value = { p: 0n, consumed: [0n, 0n, 0n], B: 0n, C: 0n, mask: 0 };
const COLORS = ["blue", "purple", "yellow"] as const;
function sum(stock: Triple) {
  return stock[0] + stock[1] + stock[2];
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
function graph(input: OracleInput) {
  const states: State[] = [];
  const ids = new Map<string, number>();
  function admit(raw: State): number {
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    if (state.grade === "SR" && state.level === 15) return -1;
    const key = [state.grade, state.level, state.exp].join(":");
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    ids.set(key, states.length);
    states.push(state);
    return states.length - 1;
  }
  const root = admit(input);
  const edges: Edge[][] = [];
  for (const state of states)
    edges.push(
      [0, 1, 2].map((color) => {
        const probability = independentProbability(state.grade, state.level, color);
        if (1000n % probability.d !== 0n)
          throw new Error("independent_layered_probability_denominator_invalid");
        const good = probability.n * (1000n / probability.d);
        return {
          good,
          bad: 1000n - good,
          success: good ? admit(independentSuccess(state.grade, state.level)) : -1,
          normal:
            good < 1000n
              ? admit(independentFailure(state.grade, state.level, state.exp, color))
              : -1,
        };
      }),
    );
  return { root, edges };
}
function* stocks(units: Triple, layer: number): Generator<Triple> {
  for (let blue = 0; blue <= Math.min(units[0], layer); blue++) {
    const remaining = layer - blue;
    for (
      let purple = Math.max(0, remaining - units[2]);
      purple <= Math.min(units[1], remaining);
      purple++
    )
      yield [blue, purple, remaining - purple];
  }
}
function plan(units: Triple, states: number) {
  let previous = 0,
    maximumLive = 0;
  for (let layer = 0; layer <= sum(units); layer++) {
    let count = 0;
    for (const _stock of stocks(units, layer)) count++;
    maximumLive = Math.max(maximumLive, (previous + count) * states);
    previous = count;
  }
  const box = (units[0] + 1) * (units[1] + 1) * (units[2] + 1);
  return {
    gameStates: states,
    totalInventoryUses: sum(units),
    cumulativeStateBox: box * states,
    maximumAdjacentLiveStates: maximumLive,
    inventoryBox: box,
  };
}
export function independentLayeredAdmission(input: OracleInput) {
  return plan(
    mapTriple(input.stock, (pieces) => Math.floor(pieces / 10)),
    graph(input).edges.length,
  );
}
type Context = {
  prices: readonly bigint[];
  denominator: bigint;
  terminal: Value;
  previous: ReadonlyMap<number, Value>;
  bases: Triple;
  box: number;
};
function stockIndex(stock: Triple, bases: Triple) {
  return (stock[0] * bases[1] + stock[1]) * bases[2] + stock[2];
}
function child(id: number, stock: Triple, context: Context): Value {
  return id < 0
    ? context.terminal
    : (context.previous.get(id * context.box + stockIndex(stock, context.bases)) ?? ZERO);
}
function consider(
  best: Value,
  edge: Edge | undefined,
  stock: Triple,
  color: number,
  context: Context,
): Value {
  const remaining = mapTriple(stock, (units, index) => units - (index === color ? 1 : 0));
  const good = edgeProperty(edge, "good")
    ? child(edgeProperty(edge, "success"), remaining, context)
    : ZERO;
  const bad = edgeProperty(edge, "bad")
    ? child(edgeProperty(edge, "normal"), remaining, context)
    : ZERO;
  const p = edgeProperty(edge, "good") * good.p + edgeProperty(edge, "bad") * bad.p;
  if (p < best.p || p === 0n) return best;
  const consumed = makeTriple(
    (index) =>
      edgeProperty(edge, "good") * good.consumed[index] +
      edgeProperty(edge, "bad") * bad.consumed[index] +
      (index === color ? 10n * context.denominator : 0n),
  );
  const B = consumed.reduce(
    (total, pieces, index) => total + multiplyPrice(pieces, context.prices[index]),
    0n,
  );
  const C = consumed.reduce((total, pieces) => total + pieces, 0n);
  if (p === best.p && (B > best.B || (B === best.B && C > best.C))) return best;
  if (p === best.p && B === best.B && C === best.C)
    return { ...best, mask: best.mask | (1 << color) };
  return { p, consumed, B, C, mask: 1 << color };
}
function evaluate(edges: EdgeRow | undefined, stock: Triple, context: Context): Value {
  let value = ZERO;
  for (let color = 0; color < 3; color++)
    if (stock[color]) value = consider(value, edgeAt(edges, color), stock, color, context);
  return value;
}
function evaluateLayers(
  game: ReturnType<typeof graph>,
  units: Triple,
  prices: readonly bigint[],
  box: number,
  limits: Limits,
) {
  const bases = mapTriple(units, (count) => count + 1);
  let previous = new Map<number, Value>(),
    denominator = 1n,
    cumulative = 0;
  for (let layer = 1; layer <= sum(units); layer++) {
    const terminal = { ...ZERO, p: denominator };
    denominator *= 1000n;
    const current = new Map<number, Value>();
    const context: Context = {
      prices,
      denominator,
      terminal,
      previous,
      bases,
      box,
    };
    for (const stock of stocks(units, layer)) {
      const index = stockIndex(stock, bases);
      for (let state = 0; state < game.edges.length; state++) {
        if ((cumulative++ & 4095) === 0) limits.check(previous.size + current.size, cumulative);
        const value = evaluate(game.edges[state], stock, context);
        if (value.p !== 0n) current.set(state * box + index, value);
      }
    }
    previous = current;
  }
  limits.check(previous.size, cumulative);
  const value =
    game.root < 0
      ? { ...ZERO, p: denominator }
      : (previous.get(game.root * box + stockIndex(units, bases)) ?? ZERO);
  return { value, denominator, cumulative };
}
/** Exhaustive UNCAPPED inventory Bellman DP. Every action consumes exactly one
 * use, so a layer with n total units depends solely on layer n-1. Old layers
 * are retired. Zero-probability STOP values share a sentinel. No candidate
 * imports, caps, interval arithmetic, relaxed policy, or approximate values.
 */
export function independentLayeredOracle(input: OracleInput, limits: Limits): OracleResult {
  const units = mapTriple(input.stock, (pieces) => Math.floor(pieces / 10));
  if (sum(units) > 150 || input.prices.some((price) => price.n < 0n))
    throw new Error("independent_layered_input_admission_invalid");
  const game = graph(input),
    admission = plan(units, game.edges.length);
  if (
    admission.cumulativeStateBox > 15000000 ||
    admission.maximumAdjacentLiveStates > limits.maxMemoEntries
  )
    throw new Error("independent_layered_state_box_admission_limit");
  if (!Number.isSafeInteger(admission.inventoryBox * (game.edges.length + 1)))
    throw new Error("independent_layered_numeric_key_admission_invalid");
  const common = input.prices.reduce(
    (denominator, price) => (denominator / gcd(denominator, price.d)) * price.d,
    1n,
  );
  const prices = mapTriple(input.prices, (price) => price.n * (common / price.d));
  const { value, denominator, cumulative } = evaluateLayers(
    game,
    units,
    prices,
    admission.inventoryBox,
    limits,
  );
  const terminal = game.root < 0,
    ties = COLORS.filter((_color, index) => value.mask & (1 << index));
  const inactiveAction = terminal ? "DONE" : "STOP";
  return {
    P: q(value.p, denominator),
    B: q(value.B, denominator * common),
    C: q(value.C, denominator),
    consumed: mapTriple(value.consumed, (pieces) => q(pieces, denominator)),
    action: ties[0] ?? inactiveAction,
    ties: ties.length ? ties : [inactiveAction],
    candidates: new Map(),
    nodes: cumulative,
  };
}
