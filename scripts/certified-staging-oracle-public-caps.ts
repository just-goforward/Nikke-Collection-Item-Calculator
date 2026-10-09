import {
  canonicalState,
  independentFailure,
  independentProbability,
  independentSuccess,
  type Triple,
} from "./certified-staging-oracle.ts";
import { makeTriple, mapTriple } from "./certified-staging-oracle-tuples.ts";

type State = ReturnType<typeof canonicalState>;
/** Public-game DAG bound over ALL actions and positive-probability outcomes.
 * For each color it maximizes that color's total future uses, independently of
 * inventory, prices, candidate policies, or candidate cap tables. Removing only
 * units above this bound preserves every feasible action/outcome policy.
 */
export function createIndependentPublicCaps() {
  const memo = new Map<string, Triple>();
  function bounds(raw: State): Triple {
    const state = canonicalState(raw.grade, raw.level, raw.exp);
    if (state.grade === "SR" && state.level === 15) return [0, 0, 0];
    const key = [state.grade, state.level, state.exp].join(":");
    const cached = memo.get(key);
    if (cached) return cached;
    let maximum: Triple = [0, 0, 0];
    for (let action = 0; action < 3; action++) {
      const probability = independentProbability(state.grade, state.level, action);
      const good =
        probability.n > 0n
          ? bounds(independentSuccess(state.grade, state.level))
          : ([0, 0, 0] as const);
      const normal =
        probability.n < probability.d
          ? bounds(independentFailure(state.grade, state.level, state.exp, action))
          : ([0, 0, 0] as const);
      maximum = mapTriple(maximum, (prior, color) =>
        Math.max(prior, (action === color ? 1 : 0) + Math.max(good[color], normal[color])),
      );
    }
    memo.set(key, maximum);
    return maximum;
  }
  return {
    bounds,
    canonicalStock(state: State, stock: Triple): Triple {
      const maximum = bounds(state);
      return makeTriple((color) => Math.min(stock[color], maximum[color]));
    },
    stateCount: () => memo.size,
  };
}
