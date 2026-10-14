import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Grade } from "../shared/game.ts";
import { frozenIndependentCohorts } from "./certified-staging-approved-panel.ts";
import {
  add,
  canonicalState,
  cmp,
  type ExactQ,
  fromWire,
  independentFailure,
  independentProbability,
  independentSuccess,
  mul,
  ONE,
  type QTriple,
  q,
  type Triple,
  wire,
  ZERO,
} from "./certified-staging-oracle.ts";
import {
  independentFourthCohort,
  independentVersionedPricing,
} from "./certified-staging-oracle-four-cohort-pricing.ts";
import { makeTriple, mapTriple } from "./certified-staging-oracle-tuples.ts";

/** Engine-independent oracle for the certified "minimum wait" label
 * (approved design: endpoint-only P-only classifier).
 *
 * Contract (one recommended batch of kit k used n times, fixed prices):
 * - supply: for day d in 1..H, every receipt vector with positive mass under some
 *   cohort with positive prior, where the reroll cohort is fixed across days
 *   (support of the 1:2:3:1 mixture = union of the four per-cohort supports);
 *   units u = floor((stock + receipts) / 10) per kit, uncapped;
 * - compensation: theta days of mixed average supply settled in whole 10-piece
 *   uses, m_j = floor(theta * rate_j / 10);
 * - u crosses iff the optimal success probability P*(s, u) is strictly greater
 *   than the batch-now probability P of Q_k,n(s, u + m); B and C never create a
 *   crossing. Values are still solved lexicographically (P max, B min, C min) so
 *   the recommendation and its tie rule are exact; the P/B/C comparison of the
 *   same pair is reported as informational bCrossingUnits;
 * - day d crosses when some support unit crosses; label = first crossing day,
 *   "7+" when no day in 1..H crosses, "unknown" when the computation is NOTRUN;
 * - certificate: theta * rate_k >= 10 n implies "7+" (reported and checked,
 *   never used as a shortcut here).
 * Arithmetic, game transitions, dispatch/box laws and pricing come only from the
 * independent BigInt staging stack; candidate solver code is never imported. */

type Wire = ReturnType<typeof wire>;
export type LawRef = { lawId: string; count: number };
export type ScheduledEvent = { id: string; day: number; refs: readonly LawRef[] };
export type PricingRules = {
  version: string;
  cadence: { numerator: number; denominator: number };
  rules: readonly {
    dispatch: readonly LawRef[];
    normalShop: readonly LawRef[];
    soloDays: readonly (readonly LawRef[])[];
  }[];
};
export type WaitLabelCase = {
  id: string;
  grade: Grade;
  level: number;
  exp: number;
  stock: Triple;
  priceBasisStock: Triple;
  cohortWeights: readonly [Wire, Wire, Wire, Wire];
  batchLimit: number;
  theta: Wire;
  horizonDays: number;
  pricing: PricingRules;
  schedule: readonly ScheduledEvent[];
};
export type Budget = { deadlineAt?: number; maxNodes?: number };
export const KITS = ["blue", "purple", "yellow"] as const;
const STOP_BIT = 8;

// ---------------------------------------------------------------- supply laws
type Outcome = { pieces: Triple; mass: ExactQ };
/** One box of each kind (public documented odds, cf. independentBoxMass). */
export const REGULAR_BOX: readonly Outcome[] = [
  { pieces: [3, 0, 0], mass: q(4, 5) },
  { pieces: [0, 1, 0], mass: q(1, 5) },
];
export const BOX_II: readonly Outcome[] = [
  { pieces: [5, 0, 0], mass: q(7, 10) },
  { pieces: [0, 2, 0], mass: q(1, 5) },
  { pieces: [0, 0, 2], mass: q(1, 10) },
];
/** Dispatch card classes: draw weight, kept on reroll, direct pieces and boxes. */
type DispatchClass = {
  weight: number;
  keep: boolean;
  direct: Triple;
  regular: number;
  second: number;
};
const card = (weight: number, keep: boolean, direct: Triple, regular = 0, second = 0) => ({
  weight,
  keep,
  direct,
  regular,
  second,
});
export const DISPATCH_CLASSES: readonly DispatchClass[] = [
  card(15, false, [2, 0, 0]),
  card(15, false, [3, 0, 0]),
  card(6, true, [0, 2, 0]),
  card(3, true, [0, 3, 0]),
  card(4, true, [0, 0, 1]),
  card(2, true, [0, 0, 2]),
  card(15, false, [0, 0, 0], 1),
  card(8, true, [0, 0, 0], 2),
  card(8, true, [0, 0, 0], 0, 1),
  card(4, true, [0, 0, 0], 0, 2),
  card(3, false, [0, 0, 0]),
  card(7, false, [0, 0, 0]),
  card(7, false, [0, 0, 0]),
  card(3, false, [0, 0, 0]),
];
const COPIES = 4;
const BOARD = 4;
type Board = { counts: readonly number[]; mass: ExactQ };
function mergeBoard(target: Map<string, Board>, counts: readonly number[], mass: ExactQ) {
  const key = counts.join(",");
  const previous = target.get(key);
  target.set(key, { counts, mass: previous ? add(previous.mass, mass) : mass });
}
/** Board after `rerolls` rerolls: weighted draws without replacement (four copies
 * per class), non-kept cards return to the deck and are redrawn. */
const boardRounds: Board[][] = [];
export function dispatchBoards(rerolls: number): Board[] {
  let boards: Board[] = boardRounds.at(-1) ?? [
    { counts: DISPATCH_CLASSES.map(() => 0), mass: ONE },
  ];
  for (let round = boardRounds.length; round <= rerolls; round++) {
    let pending = new Map<string, Board>();
    for (const board of boards)
      mergeBoard(
        pending,
        round === 0
          ? board.counts
          : board.counts.map((n, i) => (DISPATCH_CLASSES[i]?.keep ? n : 0)),
        board.mass,
      );
    for (let filled = false; !filled; ) {
      filled = true;
      const next = new Map<string, Board>();
      for (const board of pending.values()) {
        if (board.counts.reduce((sum, n) => sum + n, 0) === BOARD) {
          mergeBoard(next, board.counts, board.mass);
          continue;
        }
        filled = false;
        const weights = board.counts.map(
          (n, i) => (COPIES - n) * (DISPATCH_CLASSES[i]?.weight ?? 0),
        );
        const total = weights.reduce((sum, w) => sum + w, 0);
        weights.forEach((weight, i) => {
          if (weight === 0) return;
          const counts = board.counts.map((n, j) => n + (j === i ? 1 : 0));
          mergeBoard(next, counts, mul(board.mass, q(weight, total)));
        });
      }
      pending = next;
    }
    boards = [...pending.values()];
    assert.equal(
      cmp(
        boards.reduce((sum, board) => add(sum, board.mass), ZERO),
        ONE,
      ),
      0,
    );
    boardRounds.push(boards);
  }
  return boardRounds[rerolls] as Board[];
}
function boxMean(box: readonly Outcome[]): QTriple {
  return makeTriple((j) => box.reduce((sum, o) => add(sum, mul(o.mass, q(o.pieces[j]))), ZERO));
}
function classGain(klass: DispatchClass, regular: QTriple, second: QTriple): QTriple {
  return makeTriple((j) =>
    add(
      q(klass.direct[j]),
      add(mul(q(klass.regular), regular[j]), mul(q(klass.second), second[j])),
    ),
  );
}
/** Exact expected dispatch pieces of one reroll cohort. */
export function dispatchExpectation(rerolls: number): QTriple {
  const regular = boxMean(REGULAR_BOX);
  const second = boxMean(BOX_II);
  const gains = DISPATCH_CLASSES.map((klass) => classGain(klass, regular, second));
  let totals: QTriple = [ZERO, ZERO, ZERO];
  for (const board of dispatchBoards(rerolls))
    board.counts.forEach((n, i) => {
      const gain = gains[i];
      if (n === 0 || !gain) return;
      totals = mapTriple(totals, (total, j) => add(total, mul(board.mass, mul(q(n), gain[j]))));
    });
  return totals;
}
/** Guard: the dispatch law used for supports reproduces the independent stack's
 * frozen cohort 0..2 expectations and the separately pinned cohort-3 fixture. */
let dispatchLawVerified = false;
export function verifyDispatchLaw(): void {
  if (dispatchLawVerified) return;
  const frozen = [...frozenIndependentCohorts(), independentFourthCohort()];
  frozen.forEach((expected, rerolls) => {
    const actual = dispatchExpectation(rerolls);
    for (const j of [0, 1, 2] as const)
      assert.equal(
        cmp(actual[j], expected[j]),
        0,
        `dispatch_law_expectation_mismatch:cohort${rerolls}:kit${j}`,
      );
  });
  dispatchLawVerified = true;
}
const tripleKey = (t: Triple) => `${t[0]},${t[1]},${t[2]}`;
const plus = (a: Triple, b: Triple): Triple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** Distinct-point Minkowski sum of small point lists. */
export function minkowski(a: readonly Triple[], b: readonly Triple[]): Triple[] {
  const out = new Map<string, Triple>();
  for (const x of a)
    for (const y of b) {
      const sum = plus(x, y);
      out.set(tripleKey(sum), sum);
    }
  return [...out.values()];
}
const boxSupports = new Map<string, Triple[]>();
export function boxSupport(box: readonly Outcome[], count: number): Triple[] {
  const key = `${box === REGULAR_BOX ? "regular" : "second"}:${count}`;
  const cached = boxSupports.get(key);
  if (cached) return cached;
  let points: Triple[] = [[0, 0, 0]];
  const single = box.filter((o) => o.mass.n > 0n).map((o) => o.pieces);
  for (let i = 0; i < count; i++) points = minkowski(points, single);
  boxSupports.set(key, points);
  return points;
}
const dispatchSupports = new Map<number, Triple[]>();
/** Distinct receipt vectors with positive mass for one dispatch of a cohort. */
export function dispatchSupport(rerolls: number): Triple[] {
  const cached = dispatchSupports.get(rerolls);
  if (cached) return cached;
  const out = new Map<string, Triple>();
  for (const board of dispatchBoards(rerolls)) {
    if (board.mass.n <= 0n) continue;
    let direct: Triple = [0, 0, 0];
    let regular = 0;
    let second = 0;
    board.counts.forEach((n, i) => {
      const klass = DISPATCH_CLASSES[i] as DispatchClass;
      direct = plus(direct, [n * klass.direct[0], n * klass.direct[1], n * klass.direct[2]]);
      regular += n * klass.regular;
      second += n * klass.second;
    });
    for (const point of minkowski(
      [direct],
      minkowski(boxSupport(REGULAR_BOX, regular), boxSupport(BOX_II, second)),
    ))
      out.set(tripleKey(point), point);
  }
  const points = [...out.values()];
  dispatchSupports.set(rerolls, points);
  return points;
}
export function lawSupport(ref: LawRef, rerolls: number): Triple[] {
  assert.ok(Number.isSafeInteger(ref.count) && ref.count >= 0, "law_count");
  let unit: Triple[];
  if (ref.lawId === "dispatch-board-v1") unit = dispatchSupport(rerolls);
  else if (ref.lawId === "regular-box-v1") return boxSupport(REGULAR_BOX, ref.count);
  else if (ref.lawId === "box-ii-v1") return boxSupport(BOX_II, ref.count);
  else throw new Error(`wait_label_law_not_supported:${ref.lawId}`);
  let points: Triple[] = [[0, 0, 0]];
  for (let i = 0; i < ref.count; i++) points = minkowski(points, unit);
  return points;
}

// ------------------------------------------------------- exact reachable sets
/** Dense 3-D piece set: rows (purple, yellow) of blue bitsets. */
export class PieceSet {
  readonly max: Triple;
  readonly words: number;
  readonly data: Uint32Array;
  constructor(max: Triple) {
    this.max = max;
    this.words = (max[0] >>> 5) + 1;
    this.data = new Uint32Array((max[1] + 1) * (max[2] + 1) * this.words);
  }
  private row(p: number, y: number) {
    return (p * (this.max[2] + 1) + y) * this.words;
  }
  add(point: Triple) {
    const [b, p, y] = point;
    assert.ok(b <= this.max[0] && p <= this.max[1] && y <= this.max[2], "piece_bound");
    const index = this.row(p, y) + (b >>> 5);
    this.data[index] = (this.data[index] as number) | (1 << (b & 31));
  }
  /** Minkowski sum with a point list; bounds are pre-sized, overflow is an error. */
  plus(points: readonly Triple[]): PieceSet {
    const groups = new Map<number, number[]>();
    for (const [b, p, y] of points) {
      const key = p * 65536 + y;
      const list = groups.get(key);
      if (list) list.push(b);
      else groups.set(key, [b]);
    }
    const out = new PieceSet(this.max);
    for (let p = 0; p <= this.max[1]; p++)
      for (let y = 0; y <= this.max[2]; y++) {
        const source = this.row(p, y);
        const top = this.topBit(source);
        if (top < 0) continue;
        for (const [key, shifts] of groups)
          this.shiftInto(
            out,
            source,
            top,
            [p + Math.floor(key / 65536), y + (key % 65536)],
            shifts,
          );
      }
    return out;
  }
  private topBit(source: number): number {
    for (let w = this.words - 1; w >= 0; w--) {
      const value = this.data[source + w] as number;
      if (value !== 0) return w * 32 + 31 - Math.clz32(value);
    }
    return -1;
  }
  private shiftInto(
    out: PieceSet,
    source: number,
    top: number,
    [p, y]: readonly [number, number],
    shifts: readonly number[],
  ) {
    if (p > this.max[1] || y > this.max[2]) throw new Error("piece_bound");
    const target = out.row(p, y);
    for (const shift of shifts) {
      if (top + shift > this.max[0]) throw new Error("piece_bound");
      const ws = shift >>> 5;
      const bs = shift & 31;
      for (let w = this.words - 1; w >= ws; w--) {
        let value = (this.data[source + w - ws] as number) << bs;
        if (bs !== 0 && w - ws - 1 >= 0)
          value |= (this.data[source + w - ws - 1] as number) >>> (32 - bs);
        out.data[target + w] = (out.data[target + w] as number) | value;
      }
    }
  }
  forEach(visit: (b: number, p: number, y: number) => void) {
    for (let p = 0; p <= this.max[1]; p++)
      for (let y = 0; y <= this.max[2]; y++) {
        const source = this.row(p, y);
        for (let w = 0; w < this.words; w++) {
          let value = this.data[source + w] as number;
          while (value !== 0) {
            const low = value & -value;
            visit(w * 32 + 31 - Math.clz32(low), p, y);
            value ^= low;
          }
        }
      }
  }
}
const unitKey = (u: Triple) => u[0] * 65536 + u[1] * 256 + u[2];
const fromUnitKey = (key: number): Triple => [
  Math.floor(key / 65536),
  Math.floor(key / 256) % 256,
  key % 256,
];
const byUnits = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** Per-day sorted unit vectors reachable under some listed cohort (cohort fixed
 * across days); projection floor((stock + receipts) / 10), no inventory caps. */
export function reachableUnits(
  stock: Triple,
  schedule: readonly ScheduledEvent[],
  horizonDays: number,
  cohorts: readonly number[],
  support: (ref: LawRef, cohort: number) => readonly Triple[] = lawSupport,
): Triple[][] {
  const events = schedule.filter((event) => event.day >= 1 && event.day <= horizonDays);
  const max: [number, number, number] = [0, 0, 0];
  for (const event of events)
    for (const ref of event.refs)
      for (const j of [0, 1, 2] as const)
        max[j] += Math.max(...cohorts.flatMap((c) => support(ref, c).map((point) => point[j])));
  const days = Array.from({ length: horizonDays }, () => new Set<number>());
  const signatures = new Set<string>();
  for (const cohort of cohorts) {
    const plan = events.map((event) => event.refs.map((ref) => support(ref, cohort)));
    // Cohorts with identical per-event supports have identical reachable sets.
    const signature = JSON.stringify(plan.map((refs) => refs.map((s) => s.map(tripleKey).sort())));
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    let set = new PieceSet(max);
    set.add([0, 0, 0]);
    for (let day = 1; day <= horizonDays; day++) {
      events.forEach((event, index) => {
        if (event.day === day) for (const points of plan[index] ?? []) set = set.plus(points);
      });
      const units = days[day - 1] as Set<number>;
      set.forEach((b, p, y) => {
        units.add(
          unitKey([
            Math.floor((stock[0] + b) / 10),
            Math.floor((stock[1] + p) / 10),
            Math.floor((stock[2] + y) / 10),
          ]),
        );
      });
    }
  }
  return days.map((units) => [...units].map(fromUnitKey).sort(byUnits));
}

// ------------------------------------------------------------- value engine
type State = { grade: Grade; level: number; exp: number };
export type EngineValue = { P: bigint; c: readonly [bigint, bigint, bigint]; ties: number };
function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a, b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}
type Color = 0 | 1 | 2;
const COLORS = [0, 1, 2] as const;
const terminal = (state: State) => state.grade === "SR" && state.level >= 15;
function permille(state: State, color: Color): bigint {
  const p = independentProbability(state.grade, state.level, color);
  assert.equal((1000n * p.n) % p.d, 0n);
  return (1000n * p.n) / p.d;
}
function take(units: Triple, color: Color): Triple {
  assert.ok(units[color] >= 1, "kit_unavailable");
  return makeTriple((j) => units[j] - (j === color ? 1 : 0));
}
function memoKey(state: State, units: Triple, maxTotalUnits: number): number {
  assert.ok(state.exp % 100 === 0 && state.exp < 3000, "exp_grid");
  assert.ok(
    units.every((u) => Number.isSafeInteger(u) && u >= 0 && u < 256),
    "unit_range",
  );
  assert.ok(units[0] + units[1] + units[2] <= maxTotalUnits, "unit_scale");
  const stateId = ((state.grade === "SR" ? 1 : 0) * 16 + state.level) * 30 + state.exp / 100;
  return (stateId * 256 + units[0]) * 65536 + units[1] * 256 + units[2];
}
function checkBudget(budget: Budget, nodes: number) {
  if (budget.maxNodes !== undefined && nodes >= budget.maxNodes)
    throw new Error("wait_label_oracle_budget:nodes");
  if (budget.deadlineAt !== undefined && performance.now() >= budget.deadlineAt)
    throw new Error("wait_label_oracle_budget:time");
}
/** Lexicographic order: P max, then B = 10*sum(price_j*c_j) min, then C min. */
function lexicographic(prices: QTriple) {
  const lcm = prices.reduce((l, price) => (l / gcd(l, price.d)) * price.d, 1n);
  const weights = mapTriple(prices, (price) => price.n * (lcm / price.d));
  return (a: EngineValue, b: EngineValue): -1 | 0 | 1 => {
    if (a.P !== b.P) return a.P > b.P ? 1 : -1;
    const d = makeTriple((j) => a.c[j] - b.c[j]);
    const burden = weights[0] * d[0] + weights[1] * d[1] + weights[2] * d[2];
    if (burden !== 0n) return burden < 0n ? 1 : -1;
    const count = d[0] + d[1] + d[2];
    if (count !== 0n) return count < 0n ? 1 : -1;
    return 0;
  };
}
/** p * success + (1 - p) * normal over the fixed scale, plus one use of `color`. */
function mixer(scale: bigint) {
  const exact = (value: bigint) => {
    assert.equal(value % 1000n, 0n, "wait_label_scale_not_exact");
    return value / 1000n;
  };
  return (m: bigint, success: EngineValue | null, normal: EngineValue | null, color: Color) => {
    const part = (s: bigint | undefined, n: bigint | undefined) =>
      exact(m * (s ?? 0n) + (1000n - m) * (n ?? 0n));
    return {
      P: part(success?.P, normal?.P),
      c: makeTriple((j) => part(success?.c[j], normal?.c[j]) + (j === color ? scale : 0n)),
      ties: 0,
    };
  };
}
/** Exact lexicographic (P max, B min, C min) Bellman engine over unit stocks.
 * Values are integers over the fixed scale 1000^maxTotalUnits: every outcome
 * probability is a multiple of 1/1000 and a node with R units has at most R
 * random uses, so all divisions by 1000 are exact (asserted). c = expected units
 * consumed per kit; B = 10 * sum(price_j * c_j), C = 10 * sum(c_j). */
export function createWaitLabelEngine(prices: QTriple, maxTotalUnits: number, budget: Budget = {}) {
  const scale = 1000n ** BigInt(maxTotalUnits);
  const compare = lexicographic(prices);
  const mix = mixer(scale);
  const memo = new Map<number, EngineValue>();
  const stop: EngineValue = { P: 0n, c: [0n, 0n, 0n], ties: STOP_BIT };
  const done: EngineValue = { P: scale, c: [0n, 0n, 0n], ties: 0 };
  type Continue = (state: State, units: Triple) => EngineValue;
  const use = (state: State, units: Triple, color: Color, normal: Continue): EngineValue => {
    const next = take(units, color);
    const m = permille(state, color);
    return mix(
      m,
      m > 0n ? value(independentSuccess(state.grade, state.level), next) : null,
      m < 1000n
        ? normal(independentFailure(state.grade, state.level, state.exp, color), next)
        : null,
      color,
    );
  };
  const value = (raw: State, units: Triple): EngineValue => {
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    if (terminal(state)) return done;
    const key = memoKey(state, units, maxTotalUnits);
    const cached = memo.get(key);
    if (cached) return cached;
    checkBudget(budget, memo.size);
    let best = stop;
    let ties = STOP_BIT;
    for (const color of COLORS) {
      if (units[color] < 1) continue;
      const candidate = use(state, units, color, value);
      const order = compare(candidate, best);
      if (order > 0) [best, ties] = [candidate, 1 << color];
      else if (order === 0) ties |= 1 << color;
    }
    const result = { P: best.P, c: best.c, ties };
    memo.set(key, result);
    return result;
  };
  /** n uses of `kit` along the normal path, ending early on a great success,
   * then optimal play. */
  const batch = (raw: State, units: Triple, kit: Color, uses: number): EngineValue => {
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    if (uses === 0 || terminal(state)) return value(state, units);
    return use(state, units, kit, (next, rest) => batch(next, rest, kit, uses - 1));
  };
  const toExact = (node: EngineValue) => {
    const consumed = mapTriple(node.c, (c) => q(10n * c, scale));
    return {
      P: q(node.P, scale),
      B: add(
        add(mul(prices[0], consumed[0]), mul(prices[1], consumed[1])),
        mul(prices[2], consumed[2]),
      ),
      C: add(add(consumed[0], consumed[1]), consumed[2]),
      consumed,
    };
  };
  return { value, batch, compare, toExact, nodes: () => memo.size };
}
export type WaitLabelEngine = ReturnType<typeof createWaitLabelEngine>;

/** Independent batch contract (cf. the staging lane's normal-path prefix): first
 * optimal kit in blue/purple/yellow order; extend while the kit stays optimal on
 * the normal path; stop on a certain great success, a level/grade change, SR15 or
 * the batch limit. */
export function recommendBatch(
  engine: WaitLabelEngine,
  raw: State,
  units: Triple,
  batchLimit: number,
): { kit: Color; uses: number } | null {
  const start = canonicalState(raw.grade, raw.level, raw.exp);
  if (terminal(start)) return null;
  const root = engine.value(start, units);
  const kit = COLORS.find((color) => root.ties & (1 << color));
  if (kit === undefined) return null;
  let state = start;
  let stock = units;
  let uses = 0;
  while (uses < batchLimit) {
    if (uses > 0 && !(engine.value(state, stock).ties & (1 << kit))) break;
    uses++;
    stock = take(stock, kit);
    if (cmp(independentProbability(state.grade, state.level, kit), ONE) === 0) break;
    state = independentFailure(state.grade, state.level, state.exp, kit);
    if (
      (state.grade === "SR" && state.level === 15) ||
      state.grade !== start.grade ||
      state.level !== start.level
    )
      break;
  }
  return { kit, uses };
}

// ------------------------------------------------------------------- label
export function independentRates(
  fixture: Pick<WaitLabelCase, "pricing" | "cohortWeights">,
): QTriple {
  const [w0, w1, w2, w3] = fixture.cohortWeights;
  const priors = [fromWire(w0), fromWire(w1), fromWire(w2), fromWire(w3)] as const;
  // Only version, cadence and the single rule's refs are read by the pricing stack.
  const snapshot = fixture.pricing as Parameters<typeof independentVersionedPricing>[0];
  return independentVersionedPricing(snapshot, priors);
}
export function independentPrices(rates: QTriple, basis: Triple): QTriple {
  return mapTriple(rates, (rate, j) => q(rate.d, BigInt(basis[j]) * rate.d + rate.n));
}
/** m_j = floor(theta * rate_j / 10): whole 10-piece uses of theta days of supply. */
export function compensationUnits(theta: ExactQ, rates: QTriple): Triple {
  return mapTriple(rates, (rate) => Number((theta.n * rate.n) / (theta.d * rate.d * 10n)));
}
/** theta * rate_k >= 10 n, exactly in BigInt. */
export function certificateApplies(theta: ExactQ, rate: ExactQ, uses: number): boolean {
  return theta.n * rate.n >= 10n * BigInt(uses) * theta.d * rate.d;
}
export type DayResult = {
  day: number;
  supportUnitCount: number;
  supportUnits: Triple[];
  /** Contract: some support unit has P*(wait) > P(batch now with compensation). */
  crossing: boolean;
  crossingUnits: Triple[];
  /** Informational: the same pair compared on P, then B, then C (never a label input). */
  bCrossingUnits: Triple[];
};
export type WaitLabelResult =
  | {
      status: "EXACT";
      id: string;
      recommendation: {
        kit: (typeof KITS)[number];
        uses: number;
        value: {
          successP: Wire;
          weightedExpectedConsumptionB: Wire;
          expectedTotalConsumptionC: Wire;
        };
      };
      theta: Wire;
      rates: Wire[];
      compensationUnits: Triple;
      certificateApplies: boolean;
      certificateConsistent: boolean;
      label: number | "7+";
      perDay: DayResult[];
      engineNodes: number;
    }
  | { status: "NOTRUN"; id: string; label: "unknown"; reason: string };
export function computeWaitLabel(fixture: WaitLabelCase, budget: Budget = {}): WaitLabelResult {
  try {
    return computeExact(fixture, budget);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!reason.startsWith("wait_label_oracle_budget:")) throw error;
    return { status: "NOTRUN", id: fixture.id, label: "unknown", reason };
  }
}
function computeExact(
  fixture: WaitLabelCase,
  budget: Budget,
): WaitLabelResult & { status: "EXACT" } {
  verifyDispatchLaw();
  const rates = independentRates(fixture);
  const prices = independentPrices(rates, fixture.priceBasisStock);
  const theta = fromWire(fixture.theta);
  const m = compensationUnits(theta, rates);
  const x = mapTriple(fixture.stock, (pieces) => Math.floor(pieces / 10));
  const cohorts = fixture.cohortWeights.flatMap((w, c) => (fromWire(w).n > 0n ? [c] : []));
  const days = reachableUnits(fixture.stock, fixture.schedule, fixture.horizonDays, cohorts);
  const total = (u: Triple) => u[0] + u[1] + u[2];
  const maxTotal = Math.max(total(x), ...days.flat().map((u) => total(plus(u, m))));
  const engine = createWaitLabelEngine(prices, maxTotal, budget);
  const state = { grade: fixture.grade, level: fixture.level, exp: fixture.exp };
  const recommendation = recommendBatch(engine, state, x, fixture.batchLimit);
  if (!recommendation) throw new Error("wait_label_no_recommended_batch");
  const { kit, uses } = recommendation;
  const classified = new Map<number, { probability: boolean; lex: boolean }>();
  const classify = (u: Triple) => {
    const cached = classified.get(unitKey(u));
    if (cached) return cached;
    assert.ok(
      u.every((value, j) => value >= (x[j] ?? 0)),
      "support_below_stock",
    );
    const wait = engine.value(state, u);
    const now = engine.batch(state, plus(u, m), kit, uses);
    const verdict = { probability: wait.P > now.P, lex: engine.compare(wait, now) > 0 };
    classified.set(unitKey(u), verdict);
    return verdict;
  };
  const perDay = days.map((units, index) => {
    const crossingUnits = units.filter((u) => classify(u).probability);
    return {
      day: index + 1,
      supportUnitCount: units.length,
      supportUnits: units,
      crossing: crossingUnits.length > 0,
      crossingUnits,
      bCrossingUnits: units.filter((u) => classify(u).lex),
    };
  });
  const first = perDay.find((day) => day.crossing);
  const label = first ? first.day : ("7+" as const);
  const certificate = certificateApplies(theta, rates[kit], uses);
  const current = engine.toExact(engine.value(state, x));
  return {
    status: "EXACT",
    id: fixture.id,
    recommendation: {
      kit: KITS[kit],
      uses,
      value: {
        successP: wire(current.P),
        weightedExpectedConsumptionB: wire(current.B),
        expectedTotalConsumptionC: wire(current.C),
      },
    },
    theta: wire(theta),
    rates: rates.map(wire),
    compensationUnits: m,
    certificateApplies: certificate,
    certificateConsistent: !certificate || label === "7+",
    label,
    perDay,
    engineNodes: engine.nodes(),
  };
}

// --------------------------------------------------------------- fixtures
export const FIXTURE_DIRECTORY = fileURLToPath(
  new URL("./certified-wait-label-oracle-fixtures/", import.meta.url),
);
type FixtureFile = {
  common: Omit<WaitLabelCase, "id" | "grade" | "level" | "exp" | "stock" | "priceBasisStock">;
  fixtures: (Pick<WaitLabelCase, "id" | "grade" | "level" | "exp" | "stock" | "priceBasisStock"> &
    Record<string, unknown>)[];
};
export function loadWaitLabelFixtures(): WaitLabelCase[] {
  const file = JSON.parse(
    readFileSync(resolve(FIXTURE_DIRECTORY, "fixtures.json"), "utf8"),
  ) as FixtureFile;
  return file.fixtures.map(({ id, grade, level, exp, stock, priceBasisStock }) => ({
    ...file.common,
    id,
    grade,
    level,
    exp,
    stock,
    priceBasisStock,
  }));
}
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const expectedFile = (id: string) => resolve(FIXTURE_DIRECTORY, "expected", `${id}.json`);

/** CLI: `node scripts/certified-wait-label-oracle.ts run|record <fixtureId> [deadlineMs]`.
 * `record` writes the pre-registered expectation; measurements go to stdout only. */
function main([command, id, deadline]: string[]) {
  assert.ok(
    command === "run" || command === "record",
    "usage: run|record <fixtureId> [deadlineMs]",
  );
  const fixture = loadWaitLabelFixtures().find((entry) => entry.id === id);
  assert.ok(fixture, `unknown fixture ${id}`);
  const started = performance.now();
  const result = computeWaitLabel(fixture, {
    deadlineAt: started + Number(deadline ?? 600_000),
  });
  const elapsedMs = performance.now() - started;
  if (command === "record") {
    assert.equal(result.status, "EXACT", "only complete results are pre-registered");
    mkdirSync(resolve(FIXTURE_DIRECTORY, "expected"), { recursive: true });
    const document = {
      version: "certified-wait-label-oracle-v2",
      fixtureFileSha256: sha256(readFileSync(resolve(FIXTURE_DIRECTORY, "fixtures.json"))),
      oracleSourceSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      result,
    };
    writeFileSync(expectedFile(fixture.id), `${JSON.stringify(document)}\n`, { flag: "wx" });
  }
  const summary =
    result.status === "EXACT"
      ? {
          kit: result.recommendation.kit,
          uses: result.recommendation.uses,
          label: result.label,
          certificateApplies: result.certificateApplies,
          crossingCounts: result.perDay.map((day) => day.crossingUnits.length),
          bCrossingCounts: result.perDay.map((day) => day.bCrossingUnits.length),
          supportCounts: result.perDay.map((day) => day.supportUnitCount),
          engineNodes: result.engineNodes,
        }
      : result;
  console.log(
    JSON.stringify({
      id,
      status: result.status,
      ...summary,
      elapsedMs: Math.round(elapsedMs),
      maxRssKiB: process.resourceUsage().maxRSS,
      heapUsedBytes: process.memoryUsage().heapUsed,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
