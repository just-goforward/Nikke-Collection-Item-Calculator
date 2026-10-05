import { BoundArena } from "./boundArena";
import type { WorkBudget } from "./budget";
import { CostGuidance } from "./costGuidance";
import type { Units } from "./game";
import { GuidanceArithmetic, type Relaxation } from "./guidanceArithmetic";
import { guidedState } from "./guidanceDomain";
import { PrimaryGuidance } from "./primaryGuidance";
import type { ExactValue } from "./value";

/** Exact finite values with certified interval pruning of P and B only. C and
 * overlapping P/B comparisons always use exact integer arithmetic. Numeric
 * cells have their own upfront byte admission; exact memo admission is unchanged. */
export class GuidedFiniteTable {
  private arena: BoundArena | null = null;
  private readonly arithmetic: GuidanceArithmetic;
  private readonly primary: PrimaryGuidance;
  private readonly cost: CostGuidance;
  constructor(
    prices: readonly [bigint, bigint, bigint],
    private readonly budget: WorkBudget,
    relaxed: (sid: number) => Relaxation,
  ) {
    // Account derived constant domain/step arrays once per owning kernel;
    // allocator metadata remains separately reported by the runtime profiler.
    budget.reserve(601 * 8 + 3 * 8 + 64);
    const getArena = (): BoundArena => {
      if (!this.arena) throw new Error("certified_guidance_missing_arena");
      return this.arena;
    };
    this.arithmetic = new GuidanceArithmetic(prices, budget);
    this.primary = new PrimaryGuidance(budget, this.arithmetic, getArena);
    this.cost = new CostGuidance(budget, this.arithmetic, this.primary, getArena, relaxed);
  }
  releaseBounds(): void {
    if (this.arena) this.budget.release(this.arena.bytes);
    this.arena = null;
  }
  value(sid: number, raw: Units, enumerateRootActions: boolean): ExactValue | null {
    const state = guidedState(sid, raw);
    const cached = this.cost.cached(sid, state.units);
    if (cached && this.primary.has(sid, state.units))
      return this.arithmetic.view(this.primary.get(sid, state.units), cached);
    if (!this.arena?.supports(sid, state.units)) {
      this.releaseBounds();
      this.arena = BoundArena.create(
        sid,
        state.units,
        !this.primary.completion.has(sid, state.units),
        this.budget,
      );
    }
    if (!this.arena) return null;
    const vector = this.cost.get(sid, state.units, enumerateRootActions);
    return this.arithmetic.view(this.primary.get(sid, state.units), vector);
  }
}
