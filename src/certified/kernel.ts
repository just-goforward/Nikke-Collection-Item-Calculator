import { add, div, gcd, mul, type Q, q } from "../../shared/certifiedRational";
import { rationalPayload, type WorkBudget } from "./budget";
import {
  assertPositiveGreatProbabilities,
  capUnits,
  EDGES,
  KIT_INDICES,
  type KitIndex,
  type StateId,
  TERMINAL,
  type Units,
} from "./game";
import { GuidedFiniteTable } from "./guidedTable";
import { IntegerFiniteTable } from "./integerTable";
import type { Triple } from "./types";
import { COMPLETE, compareValue, type ExactValue, FAILED, valuePayload } from "./value";

function combine(p: Q, g: Q, n: Q): Q {
  if (p.n === 0n) return n;
  if (p.n === p.d || (g.n === n.n && g.d === n.d)) return g;
  // Form the exact weighted sum over the least common child denominator and
  // reduce once. This replaces three intermediate rational reductions.
  const common = gcd(g.d, n.d);
  const greatMultiplier = n.d / common;
  const normalMultiplier = g.d / common;
  return q(
    p.n * g.n * greatMultiplier + (p.d - p.n) * n.n * normalMultiplier,
    p.d * g.d * greatMultiplier,
  );
}

type Unlimited = { value: ExactValue; bound: Units; actions: readonly ExactValue[] };
/**
 * V(s,u)=lexmax{STOP,(p V(g,u-e_k)+(1-p)V(n,u-e_k))+(0,10w_k,10)}.
 * Terminal=(1,0,0); STOP=(0,0,0). Expected piece vectors use the same selected
 * policy. Every child has a greater sid, so this is a finite acyclic DP.
 *
 * Stock caps are maximum possible uses over ALL positive-probability action
 * paths. Above these caps no action feasibility or value can change. Raw
 * price denominators are fixed outside memo identity and are never capped.
 */
export class FiniteKernel {
  private unlimitedMemo = new Map<number, Unlimited>();
  private readonly integerTable: IntegerFiniteTable;
  private guidedTable: GuidedFiniteTable | null = null;
  readonly burdenScale: Q;
  private readonly integerWeights: readonly [Q, Q, Q];
  constructor(
    readonly weights: readonly [Q, Q, Q],
    readonly budget: WorkBudget,
  ) {
    assertPositiveGreatProbabilities();
    // One fixed positive scale preserves all strict lex comparisons and ties.
    // Integral prices avoid reducing unrelated price denominators per edge.
    this.burdenScale = q(weights[0].d * weights[1].d * weights[2].d);
    this.integerWeights = weights.map((weight) =>
      q(weight.n * (this.burdenScale.n / weight.d)),
    ) as [Q, Q, Q];
    this.budget.reserve(
      rationalPayload(this.burdenScale) +
        this.integerWeights.reduce((bytes, weight) => bytes + rationalPayload(weight), 0),
    );
    this.integerTable = new IntegerFiniteTable(
      this.integerWeights.map((price) => price.n) as [bigint, bigint, bigint],
      budget,
      (sid) => this.unlimited(sid),
    );
  }
  actualValue(value: ExactValue): ExactValue {
    return { ...value, b: div(value.b, this.burdenScale) };
  }

  private action(sid: number, kit: KitIndex, child: (s: number) => ExactValue): ExactValue {
    this.budget.tick();
    this.budget.exactTransitions++;
    const [perMille, great, normal] = EDGES[sid as StateId][kit];
    const p = q(perMille, 1000);
    const g = perMille ? child(great) : FAILED;
    const n = perMille < 1000 ? child(normal) : FAILED;
    const consumption = (k: KitIndex): Q =>
      add(combine(p, g.consumed[k], n.consumed[k]), q(k === kit ? 10 : 0));
    const consumed: [Q, Q, Q] = [consumption(0), consumption(1), consumption(2)];
    return {
      p: combine(p, g.p, n.p),
      b: add(mul(q(10), this.integerWeights[kit]), combine(p, g.b, n.b)),
      c: add(q(10), combine(p, g.c, n.c)),
      consumed,
      mask: 1 << kit,
    };
  }

  unlimited(sid: number): Unlimited {
    if (sid === TERMINAL) return { value: COMPLETE, bound: [0, 0, 0], actions: [] };
    const cached = this.unlimitedMemo.get(sid);
    if (cached) return cached;
    let best = FAILED;
    let chosen: KitIndex | null = null;
    const actions: ExactValue[] = [];
    for (const k of KIT_INDICES) {
      const action = this.action(sid, k, (s) => this.unlimited(s).value);
      actions.push(action);
      const order = compareValue(action, best);
      if (order > 0) {
        best = action;
        chosen = k;
      } else if (order === 0) best = { ...best, mask: best.mask | (1 << k) };
    }
    if (chosen === null) throw new Error("unlimited_success_invariant");
    const [p, great, normal] = EDGES[sid as StateId][chosen];
    const gb: Units = p ? this.unlimited(great).bound : [0, 0, 0];
    const nb: Units = p < 1000 ? this.unlimited(normal).bound : [0, 0, 0];
    const bound: Units = [
      Math.max(gb[0], nb[0]) + (chosen === 0 ? 1 : 0),
      Math.max(gb[1], nb[1]) + (chosen === 1 ? 1 : 0),
      Math.max(gb[2], nb[2]) + (chosen === 2 ? 1 : 0),
    ];
    const result = { value: best, bound, actions };
    this.unlimitedMemo.set(sid, result);
    this.budget.reserve(
      valuePayload(best) + actions.reduce((bytes, action) => bytes + valuePayload(action), 0) + 32,
    );
    return result;
  }

  supportsUnlimited(sid: number, units: Triple): boolean {
    const bound = this.unlimited(sid).bound;
    return KIT_INDICES.every((k) => units[k] >= bound[k]);
  }

  value(sid: number, rawUnits: Triple, enumerateRootActions = false): ExactValue {
    if (sid < TERMINAL && (this.guidedTable || rawUnits[0] + rawUnits[1] + rawUnits[2] > 36)) {
      const relaxation = this.unlimited(sid);
      if (!KIT_INDICES.every((k) => rawUnits[k] >= relaxation.bound[k])) {
        this.guidedTable ??= new GuidedFiniteTable(
          this.integerWeights.map((price) => price.n) as [bigint, bigint, bigint],
          this.budget,
          (s) => this.unlimited(s),
        );
        const value = this.guidedTable.value(sid, [...rawUnits], enumerateRootActions);
        if (value) return value;
      }
    }
    return this.integerTable.value(sid, rawUnits, enumerateRootActions);
  }
  releaseTemporaryBounds(): void {
    this.guidedTable?.releaseBounds();
  }

  solve(sid: number, raw: Triple): ExactValue {
    this.budget.check();
    this.budget.kernelCalls++;
    return this.value(sid, capUnits(sid, raw), true);
  }
}
