import { GREAT_SUCCESS, type Grade, type Kit } from "../shared/game.ts";

/** Independent arithmetic and uncapped Bellman oracle. Candidate solver code is never imported. */
export type ExactQ = Readonly<{ n: bigint; d: bigint }>;
export type Triple = readonly [number, number, number];
export type QTriple = readonly [ExactQ, ExactQ, ExactQ];
export function mapTriple<T, U>(
  values: readonly [T, T, T],
  transform: (value: T, index: number) => U,
): [U, U, U] {
  return [transform(values[0], 0), transform(values[1], 1), transform(values[2], 2)];
}
export function makeTriple<T>(transform: (index: number) => T): [T, T, T] {
  return [transform(0), transform(1), transform(2)];
}
export type OracleAction = Kit | "STOP" | "DONE";
export type OracleInput = {
  grade: Grade;
  level: number;
  exp: number;
  stock: Triple;
  prices: QTriple;
};
export type OracleValue = { P: ExactQ; B: ExactQ; C: ExactQ };
type OraclePolicyValue = OracleValue & { consumed: QTriple };
export type OracleResult = OracleValue & {
  consumed: QTriple;
  action: OracleAction;
  ties: readonly OracleAction[];
  candidates: ReadonlyMap<OracleAction, OraclePolicyValue>;
  nodes: number;
};

const COLORS = ["blue", "purple", "yellow"] as const;
export const ZERO: ExactQ = { n: 0n, d: 1n };
export const ONE: ExactQ = { n: 1n, d: 1n };
function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}
export function q(n: bigint | number, d: bigint | number = 1n): ExactQ {
  let nn = BigInt(n);
  let dd = BigInt(d);
  if (dd === 0n) throw new Error("Oracle zero denominator");
  if (dd < 0n) [nn, dd] = [-nn, -dd];
  const divisor = gcd(nn, dd);
  return { n: nn / divisor, d: dd / divisor };
}
export function add(a: ExactQ, b: ExactQ): ExactQ {
  return q(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function mul(a: ExactQ, b: ExactQ): ExactQ {
  return q(a.n * b.n, a.d * b.d);
}
export function cmp(a: ExactQ, b: ExactQ): -1 | 0 | 1 {
  const difference = a.n * b.d - b.n * a.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function decimal(value: number | string): ExactQ {
  const text = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Unsupported exact decimal ${text}`);
  const [whole = "0", fraction = ""] = text.split(".");
  return q(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length));
}
export function wire(value: ExactQ): { numerator: string; denominator: string } {
  return { numerator: value.n.toString(), denominator: value.d.toString() };
}
export function fromWire(value: { numerator: string; denominator: string }): ExactQ {
  return q(BigInt(value.numerator), BigInt(value.denominator));
}
export function format(value: ExactQ): string {
  return `${value.n}/${value.d}`;
}
export function approx(value: ExactQ): number {
  return Number(value.n) / Number(value.d);
}
export function compareValue(a: OracleValue, b: OracleValue): -1 | 0 | 1 {
  const probability = cmp(a.P, b.P);
  if (probability !== 0) return probability;
  const burden = cmp(a.B, b.B);
  if (burden !== 0) return burden === 1 ? -1 : 1;
  const consumption = cmp(a.C, b.C);
  return consumption === 0 ? 0 : consumption === 1 ? -1 : 1;
}
export function equalValue(a: OracleValue, b: OracleValue): boolean {
  return cmp(a.P, b.P) === 0 && cmp(a.B, b.B) === 0 && cmp(a.C, b.C) === 0;
}
function zeroValue(): OraclePolicyValue {
  return { P: ZERO, B: ZERO, C: ZERO, consumed: [ZERO, ZERO, ZERO] };
}
function weighted(
  p: ExactQ,
  success: OraclePolicyValue,
  failure: OraclePolicyValue,
): OraclePolicyValue {
  const failureProbability = q(p.d - p.n, p.d);
  return {
    P: add(mul(p, success.P), mul(failureProbability, failure.P)),
    B: add(mul(p, success.B), mul(failureProbability, failure.B)),
    C: add(mul(p, success.C), mul(failureProbability, failure.C)),
    consumed: makeTriple((color) =>
      add(mul(p, success.consumed[color]!), mul(failureProbability, failure.consumed[color]!)),
    ),
  };
}
export function canonicalState(grade: Grade, level: number, exp: number) {
  return grade === "R" && level >= 15
    ? { grade: "SR" as const, level: 5, exp: 0 }
    : { grade, level, exp: level >= 15 ? 0 : exp };
}
/** Re-derived from game rules: ordinary EXP is discarded on a stage boundary. */
export function independentSuccess(grade: Grade, level: number) {
  return canonicalState(grade, level < 5 ? 5 : level < 10 ? 10 : 15, 0);
}
export function independentFailure(grade: Grade, level: number, exp: number, kitIndex: number) {
  let nextLevel = level;
  let nextExp = exp + [200, 500, 1000][kitIndex]!;
  const required = grade === "R" ? 1000 : 3000;
  while (nextLevel < 15 && nextExp >= required) {
    nextExp -= required;
    nextLevel += 1;
    if (nextLevel % 5 === 0) {
      nextExp = 0;
      break;
    }
  }
  return canonicalState(grade, nextLevel, nextExp);
}
export function independentProbability(grade: Grade, level: number, kitIndex: number): ExactQ {
  const percentage = GREAT_SUCCESS[grade][COLORS[kitIndex]!][level];
  if (percentage === null || percentage === undefined) throw new Error("Missing game probability");
  return mul(decimal(percentage), q(1n, 100n));
}

export function createOracleEvaluator(
  prices: QTriple,
): (input: Omit<OracleInput, "prices">) => OracleResult {
  const memo = new Map<string, Omit<OracleResult, "nodes">>();
  const solve = (
    rawGrade: Grade,
    rawLevel: number,
    rawExp: number,
    stock: Triple,
  ): Omit<OracleResult, "nodes"> => {
    const { grade, level, exp } = canonicalState(rawGrade, rawLevel, rawExp);
    const key = [grade, level, exp, ...stock].join(":");
    const existing = memo.get(key);
    if (existing) return existing;
    if (grade === "SR" && level >= 15) {
      const result = {
        P: ONE,
        B: ZERO,
        C: ZERO,
        consumed: [ZERO, ZERO, ZERO] as QTriple,
        action: "DONE" as const,
        ties: ["DONE"] as const,
        candidates: new Map<OracleAction, OraclePolicyValue>(),
      };
      memo.set(key, result);
      return result;
    }
    const candidates = new Map<OracleAction, OraclePolicyValue>([["STOP", zeroValue()]]);
    let best: OraclePolicyValue = zeroValue();
    let action: OracleAction = "STOP";
    let ties: OracleAction[] = ["STOP"];
    for (let index = 0; index < 3; index += 1) {
      if (stock[index]! < 10) continue;
      const nextStock = mapTriple(stock, (pieces, color) => pieces - (color === index ? 10 : 0));
      const successState = independentSuccess(grade, level);
      const failureState = independentFailure(grade, level, exp, index);
      const value = weighted(
        independentProbability(grade, level, index),
        solve(successState.grade, successState.level, successState.exp, nextStock),
        solve(failureState.grade, failureState.level, failureState.exp, nextStock),
      );
      value.B = add(q(10n * prices[index]!.n, prices[index]!.d), value.B);
      value.C = add(q(10n), value.C);
      value.consumed = mapTriple(value.consumed, (consumed, color) =>
        add(consumed, q(color === index ? 10 : 0)),
      );
      const kit = COLORS[index]!;
      candidates.set(kit, value);
      const comparison = compareValue(value, best);
      if (comparison > 0) [best, action, ties] = [value, kit, [kit]];
      else if (comparison === 0) ties.push(kit);
    }
    const result = { ...best, action, ties, candidates };
    memo.set(key, result);
    return result;
  };
  return (input) => ({
    ...solve(input.grade, input.level, input.exp, input.stock),
    nodes: memo.size,
  });
}
export function solveOracle(input: OracleInput): OracleResult {
  return createOracleEvaluator(input.prices)(input);
}

export type GainOutcome = { stock: Triple; probability: ExactQ };
export type OracleEvent = {
  day: number;
  byCohort: readonly [readonly GainOutcome[], readonly GainOutcome[], readonly GainOutcome[]];
};
function appendMass(states: Map<string, GainOutcome>, stock: Triple, probability: ExactQ) {
  const key = stock.join(",");
  const previous = states.get(key);
  states.set(key, {
    stock,
    probability: previous ? add(previous.probability, probability) : probability,
  });
}
function convolveReceipts(
  states: Map<string, GainOutcome>,
  receipts: readonly GainOutcome[],
): Map<string, GainOutcome> {
  const next = new Map<string, GainOutcome>();
  for (const state of states.values()) {
    for (const receipt of receipts) {
      appendMass(
        next,
        mapTriple(state.stock, (pieces, color) => pieces + receipt.stock[color]!),
        mul(state.probability, receipt.probability),
      );
    }
  }
  return next;
}
export function futureStockDistribution(
  initial: Triple,
  events: readonly OracleEvent[],
  day: number,
  cohortWeights: QTriple,
): GainOutcome[] {
  const combined = new Map<string, GainOutcome>();
  for (let cohort = 0; cohort < 3; cohort += 1) {
    if (cmp(cohortWeights[cohort]!, ZERO) === 0) continue;
    let states = new Map<string, GainOutcome>([
      [initial.join(","), { stock: initial, probability: cohortWeights[cohort]! }],
    ]);
    for (const event of events.filter((candidate) => candidate.day <= day)) {
      states = convolveReceipts(states, event.byCohort[cohort]!);
    }
    for (const state of states.values()) appendMass(combined, state.stock, state.probability);
  }
  return [...combined.values()];
}
export function averageOracle(
  input: OracleInput,
  distribution: readonly GainOutcome[],
  evaluate = createOracleEvaluator(input.prices),
): OracleValue {
  let value: OracleValue = zeroValue();
  for (const outcome of distribution) {
    const solved = evaluate({ ...input, stock: outcome.stock });
    value = {
      P: add(value.P, mul(outcome.probability, solved.P)),
      B: add(value.B, mul(outcome.probability, solved.B)),
      C: add(value.C, mul(outcome.probability, solved.C)),
    };
  }
  return value;
}
