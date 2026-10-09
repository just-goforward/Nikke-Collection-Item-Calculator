import type { Interval } from "../../shared/certifiedRational";
import type { WorkBudget } from "./budget";
import { outwardWidth, positiveUp, UNKNOWN_BOUND } from "./directedBounds";
import { CAPS, KIT_INDICES, type StateId, type StateValues, TERMINAL, type Units } from "./game";

type Layout = {
  offsets: Uint32Array & StateValues<number>;
  purple: Uint16Array & StateValues<number>;
  yellow: Uint16Array & StateValues<number>;
  cells: number;
};
type Page = { lower: Float64Array; width: Float32Array; status: Uint8Array };
const LAYOUT_BYTES = (TERMINAL + 1) * 8 + 24;
const PAGE_CELLS = 4096;
const EXACT_HEADROOM = 16 * 1024 * 1024;
function fits(value: number, upper: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= upper;
}
function layout(rootSid: number, root: Units, budget: WorkBudget): Layout {
  const offsets = new Uint32Array(TERMINAL + 1) as Uint32Array & StateValues<number>;
  const purple = new Uint16Array(TERMINAL + 1) as Uint16Array & StateValues<number>;
  const yellow = new Uint16Array(TERMINAL + 1) as Uint16Array & StateValues<number>;
  let cells = 0;
  for (let sid = rootSid; sid < TERMINAL; sid++) {
    budget.tick();
    offsets[sid] = cells;
    const state = sid as StateId;
    const caps = CAPS[state];
    const purpleRadix = Math.min(root[1], caps[1]) + 1;
    const yellowRadix = Math.min(root[2], caps[2]) + 1;
    purple[sid] = purpleRadix;
    yellow[sid] = yellowRadix;
    cells += (Math.min(root[0], caps[0]) + 1) * purple[state] * yellow[state];
  }
  if (!Number.isSafeInteger(cells) || cells >= 2 ** 32) throw new Error("certified_bound_domain");
  return { offsets, purple, yellow, cells };
}

/**
 * Jagged mixed radix per sid: (blue*purpleRadix+purple)*yellowRadix+yellow.
 * Disjoint prefix offsets and checked digits make the index injective. Each
 * visited page owns 8 bytes lower +4 bytes outward width +1 byte status per
 * cell. Unvisited pages allocate nothing. Every page is separately admitted
 * by exact byte length before allocation; numeric cells are not exact memo rows.
 */
export class BoundArena {
  private retainedBytes = LAYOUT_BYTES;
  private readonly costPages = new Map<number, Page>();
  private readonly failurePages = new Map<number, Page>();
  private constructor(
    private readonly rootSid: number,
    private readonly root: Units,
    private readonly domain: Layout,
    private readonly hasFailure: boolean,
    private readonly budget: WorkBudget,
  ) {}
  get bytes(): number {
    return this.retainedBytes;
  }
  static create(
    sid: number,
    root: Units,
    hasFailure: boolean,
    budget: WorkBudget,
  ): BoundArena | null {
    if (!budget.canReserve(LAYOUT_BYTES)) return null;
    budget.reserve(LAYOUT_BYTES);
    const domain = layout(sid, root, budget);
    return new BoundArena(sid, [...root], domain, hasFailure, budget);
  }
  supports(sid: number, units: Units): boolean {
    return (
      Number.isInteger(sid) &&
      sid >= this.rootSid &&
      sid < TERMINAL &&
      units.length === 3 &&
      fits(units[0], this.root[0]) &&
      fits(units[1], this.root[1]) &&
      fits(units[2], this.root[2])
    );
  }
  private index(sid: number, units: Units): number {
    // Callers have capped units. Checking these dimensions additionally avoids
    // aliases if a future caller accidentally supplies an uncapped stock.
    if (!this.supports(sid, units)) throw new Error("certified_bound_index_outside_domain");
    const state = sid as StateId;
    const caps = CAPS[state];
    const offset = this.domain.offsets[state];
    const purple = this.domain.purple[state];
    const yellow = this.domain.yellow[state];
    if (KIT_INDICES.some((k) => units[k] > caps[k]))
      throw new Error("certified_bound_index_outside_domain");
    return offset + (units[0] * purple + units[1]) * yellow + units[2];
  }
  get(kind: "failure" | "cost", sid: number, units: Units): Interval | null {
    const i = this.index(sid, units);
    const page = this.pages(kind).get(Math.floor(i / PAGE_CELLS));
    const row = i % PAGE_CELLS;
    if (!page?.status[row]) return null;
    const lo = page.lower[row]!;
    const width = page.width[row]!;
    const hi = positiveUp(lo + width);
    return Number.isFinite(hi) ? { lo, hi } : UNKNOWN_BOUND;
  }
  put(kind: "failure" | "cost", sid: number, units: Units, value: Interval): void {
    const width = outwardWidth(value.lo, value.hi);
    if (width === null) return;
    if (kind === "failure" && !this.hasFailure) return;
    const i = this.index(sid, units);
    const pageId = Math.floor(i / PAGE_CELLS);
    const page = this.pages(kind).get(pageId) ?? this.allocate(kind, pageId);
    if (!page) return;
    const row = i % PAGE_CELLS;
    page.lower[row] = value.lo;
    page.width[row] = width;
    page.status[row] = 1;
  }
  private pages(kind: "failure" | "cost"): Map<number, Page> {
    return kind === "failure" ? this.failurePages : this.costPages;
  }
  private allocate(kind: "failure" | "cost", pageId: number): Page | null {
    const cells = Math.min(PAGE_CELLS, this.domain.cells - pageId * PAGE_CELLS);
    const bytes = cells * 13 + 40;
    // Optional cached bounds may be omitted. Preserve room for the exact pass;
    // a missing cell only triggers recomputation, never a guessed comparison.
    if (!this.budget.canReserve(bytes + EXACT_HEADROOM)) return null;
    this.budget.reserve(bytes);
    const page: Page = {
      lower: new Float64Array(cells),
      width: new Float32Array(cells),
      status: new Uint8Array(cells),
    };
    this.pages(kind).set(pageId, page);
    this.retainedBytes += bytes;
    return page;
  }
}
