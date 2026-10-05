import type { WorkBudget } from "./budget";
import { EDGES, TERMINAL, type Units } from "./game";
import { GUIDE_DIMENSIONS } from "./guidanceDomain";

function worstSuccessor(sid: number, kit: number): number {
  const [p, great, normal] = EDGES[sid]![kit]!;
  return p === 1000 ? great : normal;
}

function verifyOrderedDomain(domain: readonly number[]): void {
  for (let kit = 0; kit < 3; kit++) {
    let previous = -1;
    for (const sid of domain) {
      const [p, great, normal] = EDGES[sid]![kit]!;
      const worst = worstSuccessor(sid, kit);
      if (p > 0 && great < normal) throw new Error("certified_worst_branch_order");
      if (worst < previous) throw new Error("certified_worst_transition_nonmonotone");
      previous = worst;
    }
  }
}

/**
 * P=1 iff some positive all-worst branch completes. Its fixed kit sequence
 * also completes on every other branch: great>=normal and every worst map
 * is monotone on the two actual reachable grade domains, verified below.
 * This integer recurrence minimizes blue uses for each available purple/yellow
 * pair. It is an exact feasibility test, independent of cost or probability size.
 */
export class CertainCompletion {
  private readonly yellow = GUIDE_DIMENSIONS[2]!;
  private readonly stride = GUIDE_DIMENSIONS[1]! * this.yellow;
  private readonly minimumBlue: Uint16Array;
  constructor(budget: WorkBudget) {
    verifyOrderedDomain([
      ...Array.from({ length: 150 }, (_, i) => i),
      ...Array.from({ length: 301 }, (_, i) => i + 300),
    ]);
    verifyOrderedDomain(Array.from({ length: 451 }, (_, i) => i + 150));
    const cells = (TERMINAL + 1) * this.stride;
    budget.reserve(cells * 2 + 32);
    this.minimumBlue = new Uint16Array(cells);
    for (let sid = TERMINAL - 1; sid >= 0; sid--) this.fill(sid, budget);
  }
  private fill(sid: number, budget: WorkBudget): void {
    const blue = worstSuccessor(sid, 0) * this.stride;
    const purple = worstSuccessor(sid, 1) * this.stride;
    const yellow = worstSuccessor(sid, 2) * this.stride;
    for (let p = 0; p < GUIDE_DIMENSIONS[1]!; p++) {
      for (let y = 0; y < this.yellow; y++) {
        budget.tick();
        const offset = p * this.yellow + y;
        let need = 1 + this.minimumBlue[blue + offset]!;
        if (p > 0) need = Math.min(need, this.minimumBlue[purple + offset - this.yellow]!);
        if (y > 0) need = Math.min(need, this.minimumBlue[yellow + offset - 1]!);
        if (need > 65535) throw new Error("certified_completion_uint16_overflow");
        this.minimumBlue[sid * this.stride + offset] = need;
      }
    }
  }
  has(sid: number, units: Units): boolean {
    return units[0] >= this.minimumBlue[sid * this.stride + units[1] * this.yellow + units[2]]!;
  }
  actionHas(sid: number, kit: number, units: Units): boolean {
    if (units[kit] === 0) return false;
    const remaining: Units = [...units];
    remaining[kit]!--;
    return this.has(worstSuccessor(sid, kit), remaining);
  }
  mask(sid: number, units: Units): number {
    return [0, 1, 2].reduce((mask, k) => mask | (this.actionHas(sid, k, units) ? 1 << k : 0), 0);
  }
}
