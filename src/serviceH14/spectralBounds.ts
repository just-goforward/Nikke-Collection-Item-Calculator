import { BOX_LAWS, DISPATCH_CLASSES, type CertifiedSupplyLaw, type Triple } from "../../shared/certifiedSupplyLaws";
import type { Q } from "../../shared/certifiedRational";
import type { CertifiedEvidenceBudget } from "../certified/types";
import type { JointSourceDescriptor } from "./types";
import { up as nextBinary64 } from "./numeric";

/** Count-state tables (at most C(18,4)=3060 states), finite marginal tables,
 * and one-axis moment/search tables. No global cache escapes this reservation. */
export function spectralBoundsWorkspaceBound(
  laws: readonly CertifiedSupplyLaw[],
  events: readonly { refs: readonly { lawId: string }[] }[],
): number {
  // Search ratios and two 95-entry binary64 tables, including their wrappers.
  let bytes = SPECTRAL_BOUNDS_WORKSPACE_BYTES + 4096;
  const used = new Set<string>();
  for (const event of events) for (const ref of event.refs) {
    charge("hostStateVisits");
    charge("hostScalarOps");
    bytes += 128; // transient unique-ID set and reference traversal storage
    used.add(ref.lawId);
  }
  for (const id of used) {
    const finite = laws.find((law) => { charge("hostStateVisits"); return law.id === id && law.kind === "finite"; });
    const rows = finite
      ? finite.outcomesByCohort
        ? finite.outcomesByCohort.reduce((sum, outcomes) => { charge("hostScalarOps"); return sum + outcomes.length; }, 0)
        : 4 * (finite.outcomes?.length ?? 0)
      : id === "dispatch-board-v1" ? 4 * 2380 : 4 * 3;
    // Every distinct referenced ID can own four models and 3*95 cached
    // moments/model, even when a deterministic ID is absent from laws.
    charge("hostScalarOps", 6);
    bytes += rows * 256 + 4 * 32768 + 8 * id.length;
    if (!finite && id === "dispatch-board-v1") {
      bytes += 256 + Float64Array.BYTES_PER_ELEMENT * LOOSE_EXPONENTS * BOX_EXPONENTS * BOX_EXPONENTS;
      // Three row→factor index arrays per dispatch model; one shared value scratch.
      bytes += 4 * 3 * (256 + 2380 * Int16Array.BYTES_PER_ELEMENT);
    }
  }
  return bytes;
}
export const SPECTRAL_BOUNDS_WORKSPACE_BYTES = 16 * 1024 * 1024;
export const SPECTRAL_GRID: Triple = [300, 120, 80];
export const SPECTRAL_ROOT_ERROR = 2 ** -47;
/** Approved unit: ceil(combined raw host/native work / 8) <= 200M. */
export const SPECTRAL_RAW_WORK_LIMIT = 1_600_000_000;
const U = 2 ** -53;
export type SpectralHostWork = { hostScalarOps: number; hostStateVisits: number; hostIntegerOps: number };
/** performedWork is the RAW debit, never already divided by eight. */
export type SpectralBoundsResult = { dates: readonly SpectralDateBound[]; performedWork: number; work: SpectralHostWork };
class BoundWorkLimit extends Error {}
// Synchronous, stack-scoped ledger: nested budget callbacks restore their
// caller's ledger, and no retained/global numerical cache crosses requests.
let activeWork: SpectralHostWork | undefined;
let remainingWork = 0;
function charge(category: keyof SpectralHostWork, count = 1): void {
  if (!activeWork) return;
  if (count > remainingWork) throw new BoundWorkLimit();
  remainingWork -= count;
  activeWork[category] += count;
}
function up(x: number): number {
  // A rounded operation and its nextafter enclosure, including one logical
  // bit increment. Charge the same prefix even at the last 0..2 operations.
  if (activeWork) {
    if (remainingWork < 3) {
      charge("hostScalarOps", 2);
      charge("hostIntegerOps");
    } else {
      remainingWork -= 3;
      activeWork.hostScalarOps += 2;
      activeWork.hostIntegerOps++;
    }
  }
  return nextBinary64(x);
}
function down(x: number): number { return -up(-x); }
const plus = (a: number, b: number) => a === 0 ? b : b === 0 ? a : up(a + b);
const times = (a: number, b: number) => a === 0 || b === 0 ? 0 : up(a * b);
function pow(x: number, n: number, upper = true): number {
  let result = 1;
  const round = upper ? up : down;
  while (n > 0) {
    charge("hostIntegerOps", 3);
    if (n % 2 === 1) result = round(result * x);
    n = Math.floor(n / 2);
    if (n) x = round(x * x);
  }
  return result;
}
function rationalUpper(q: Q): number {
  charge("hostIntegerOps", 5); // shift, add, subtract, divide, Number conversion
  if (q.n === 0n) return 0;
  // Avoid converting arbitrary-size integers to Infinity: a 64-bit binary
  // quotient gives an exact rational enclosure with at most 2^-64 excess.
  const scaled = ((q.n << 64n) + q.d - 1n) / q.d;
  return up(Number(scaled) / 2 ** 64);
}
type Raw = { raw: readonly number[]; mass: number };
type Board = { counts: number[]; mass: number };
// Four built-in dispatch slots currently pay at most 12 loose pieces per axis
// and 8 boxes of either kind. Larger exponents always take the general path.
const LOOSE_EXPONENTS = 13, BOX_EXPONENTS = 9;
type Model = { rows: Raw[]; min: Triple; max: Triple; mean: Triple; moments: Map<number, number>[];
  dispatch?: { indices: Int16Array[]; factors: Float64Array } };
export type SpectralDateBound = { window: Triple; sourceL1Upper: number };

/** Exact physical transition probabilities, enclosed upward. This repeats the
 * count-state model rather than assuming independent slots or using a cached
 * producer distribution. Removed classes reenter the pool on each reroll. */
function dispatchModels(cohortCount: number, check: () => void): Raw[][] {
  let kept = new Map<string, Board>();
  kept.set("0", { counts: DISPATCH_CLASSES.map(() => 0), mass: 1 });
  const result: Raw[][] = [];
  const merge = (map: Map<string, Board>, counts: number[], mass: number) => {
    const key = counts.join(",");
    const old = map.get(key);
    if (old) old.mass = plus(old.mass, mass);
    else map.set(key, { counts, mass });
  };
  for (let c = 0; c < cohortCount; c++) {
    const buckets = Array.from({ length: 5 }, () => new Map<string, Board>());
    for (const row of kept.values()) {
      charge("hostScalarOps", row.counts.length);
      merge(buckets[row.counts.reduce((a, b) => a + b, 0)]!, row.counts, row.mass);
    }
    for (let size = 0; size < 4; size++) {
      for (const row of buckets[size]!.values()) {
        check();
        let total = 0;
        for (let i = 0; i < DISPATCH_CLASSES.length; i++) { charge("hostScalarOps", 3); total += (4 - row.counts[i]!) * DISPATCH_CLASSES[i]!.weight; }
        for (let i = 0; i < DISPATCH_CLASSES.length; i++) {
          charge("hostStateVisits");
          charge("hostScalarOps");
          const available = 4 - row.counts[i]!;
          if (!available) continue;
          const counts = row.counts.slice();
          charge("hostScalarOps", 3); // count increment, bucket increment, numerator multiplication
          counts[i] = counts[i]! + 1;
          merge(buckets[size + 1]!, counts, times(row.mass, up(available * DISPATCH_CLASSES[i]!.weight / total)));
        }
      }
    }
    const raw = new Map<string, Raw>();
    kept = new Map();
    for (const row of buckets[4]!.values()) {
      check();
      const pieces = [0, 0, 0, 0, 0];
      for (let i = 0; i < DISPATCH_CLASSES.length; i++) {
        charge("hostStateVisits");
        const count = row.counts[i]!;
        if (!count) continue;
        for (let k = 0; k < 5; k++) { charge("hostScalarOps", 2); pieces[k] = pieces[k]! + count * DISPATCH_CLASSES[i]!.raw[k]!; }
      }
      const key = pieces.join(",");
      const old = raw.get(key);
      if (old) old.mass = plus(old.mass, row.mass);
      else raw.set(key, { raw: pieces, mass: row.mass });
      if (c + 1 < cohortCount) merge(kept, row.counts.map((n, i) => DISPATCH_CLASSES[i]!.keep ? n : 0), row.mass);
    }
    result.push([...raw.values()]);
  }
  return result;
}
function model(rows: Raw[], check: () => void, dispatchFactors: Float64Array | undefined): Model {
  const lo = [Infinity, Infinity, Infinity], hi = [0, 0, 0], mean = [0, 0, 0];
  // These physical box extrema and search means depend on the axis, not
  // on the raw dispatch row. Keep each mean's original term order.
  const stats = (law: typeof BOX_LAWS.regular | typeof BOX_LAWS.boxII) => [0, 1, 2].map(k => {
    let min = Infinity, max = 0, avg = 0;
    for (const row of law) {
      charge("hostStateVisits");
      charge("hostScalarOps", 5);
      charge("hostIntegerOps", 2);
      const n = row.pieces[k]!;
      min = Math.min(min, n); max = Math.max(max, n);
      avg = avg + n * Number(row.mass.n) / Number(row.mass.d);
    }
    return { min, max, avg };
  });
  const regular = stats(BOX_LAWS.regular), ii = stats(BOX_LAWS.boxII);
  const indices = dispatchFactors ? Array.from({ length: 3 }, () => {
    charge("hostStateVisits", rows.length);
    return new Int16Array(rows.length);
  }) : undefined;
  let visited = 0;
  for (let i = 0; i < rows.length; i++) for (let k = 0; k < 3; k++) {
    const row = rows[i]!;
    if (indices) {
      const x = row.raw[k]!, r = row.raw[3]!, b = row.raw[4]!;
      charge("hostIntegerOps", 3);
      let index = -1; // Larger exponents retain the general pow path.
      if (x < LOOSE_EXPONENTS && r < BOX_EXPONENTS && b < BOX_EXPONENTS) {
        charge("hostIntegerOps", 4);
        index = x + LOOSE_EXPONENTS * (r + BOX_EXPONENTS * b);
      }
      charge("hostStateVisits");
      indices[k]![i] = index;
    }
    charge("hostIntegerOps", 2);
    if (++visited % 64 === 0) check();
    const box = regular[k]!, boxII = ii[k]!;
    charge("hostStateVisits");
    charge("hostScalarOps", 8);
    const lower = row.raw[k]! + row.raw[3]! * box.min + row.raw[4]! * boxII.min;
    const upper = row.raw[k]! + row.raw[3]! * box.max + row.raw[4]! * boxII.max;
    lo[k] = Math.min(lo[k]!, lower); hi[k] = Math.max(hi[k]!, upper);
    // This mean is only a search center, never part of a proof bound.
    charge("hostScalarOps", 6);
    mean[k] = mean[k]! + row.mass * (row.raw[k]! + row.raw[3]! * box.avg + row.raw[4]! * boxII.avg);
  }
  return { rows, min: lo as unknown as Triple, max: hi as unknown as Triple, mean: mean as unknown as Triple,
    moments: [new Map(), new Map(), new Map()], ...(indices && dispatchFactors ? { dispatch: { indices, factors: dispatchFactors } } : {}) };
}
function moment(m: Model, axis: number, z: number, check: () => void): number {
  const cached = m.moments[axis]!.get(z);
  if (cached !== undefined) return cached;
  const box = (law: typeof BOX_LAWS.regular | typeof BOX_LAWS.boxII) => law.reduce((s, row) => plus(s, times(rationalUpper(row.mass), pow(z, row.pieces[axis]!))), 0);
  const regular = box(BOX_LAWS.regular), ii = box(BOX_LAWS.boxII);
  let sum = 0;
  // A factor depends only on (axis, z, loose pieces, regular boxes, II boxes),
  // not on a row's mass or its other two loose-piece coordinates. Cache the
  // SAME rounded expression, never combine row masses or reassociate sums.
  // Scratch is shared only across synchronous moments of this derivation.
  const factors = m.dispatch?.factors, indices = m.dispatch?.indices[axis];
  if (factors) { charge("hostStateVisits", factors.length); factors.fill(0); }
  let visited = 0;
  for (let i = 0; i < m.rows.length; i++) {
    const row = m.rows[i]!;
    charge("hostIntegerOps", 2);
    if (++visited % 64 === 0) check();
    charge("hostStateVisits");
    if (indices) charge("hostStateVisits");
    const index = indices ? indices[i]! : -1;
    let factor: number;
    if (factors && index >= 0) {
      charge("hostStateVisits");
      factor = factors[index]!;
      if (factor === 0) {
        factor = times(pow(z, row.raw[axis]!), times(pow(regular, row.raw[3]!), pow(ii, row.raw[4]!)));
        charge("hostStateVisits"); factors[index] = factor;
      }
    } else {
      factor = times(pow(z, row.raw[axis]!), times(pow(regular, row.raw[3]!), pow(ii, row.raw[4]!)));
    }
    sum = plus(sum, times(row.mass, factor));
  }
  m.moments[axis]!.set(z, sum);
  return sum;
}
/** Conservative numeric envelope for the documented direct radix<=5 circuit.
 * The native implementation must satisfy the input/debit contract below. */
export function spectralNumericalBound(draws: number): number {
  if (!Number.isSafeInteger(draws) || draws < 0) return 2;
  // Q63 per-law full-L1 floor/construction debit <=1M/2^63; exact integer
  // grid accumulation, then correctly rounded conversion (<=u full L1).
  let error = plus(1_000_000 / 2 ** 63, U);
  // A direct radix5 node: products, four additions, and an outside twiddle.
  const t = SPECTRAL_ROOT_ERROR;
  const mulError = plus(t, times(8 * U, plus(1, t)));
  let stage = mulError;
  for (let i = 0; i < 4; i++) stage = plus(stage, times(U, plus(1, stage)));
  stage = plus(stage, times(mulError, plus(1, stage)));
  for (let i = 0; i < 15; i++) error = plus(error, times(stage, plus(1, error)));
  // Weighted error multiplicity of binary power circuit is <=2m; compute
  // (1+e)^m-1 without catastrophic subtractive cancellation.
  const compose = (a: number, b: number) => plus(plus(a, b), times(a, b));
  const exponentError = (e: number, n: number) => {
    let out = 0;
    while (n > 0) { charge("hostIntegerOps", 3); if (n % 2 === 1) out = compose(out, e); n = Math.floor(n / 2); if (n) e = compose(e, e); }
    return out;
  };
  charge("hostScalarOps");
  error = compose(exponentError(error, draws), exponentError(8 * U, 2 * draws));
  // Exact folding is L1-contractive; sqrt(N)<1698. The per-mode filter is
  // tensor product of ten-root means, raw-residue and small-grid whole-unit
  // phases. Per axis: three root errors, sum/divide10u, residue8u,
  // tensor8u, whole-unit8u, with remaining14u covering cross terms and
  // optional combined small-phase assembly.
  let filter = 0;
  for (let i = 0; i < 3; i++) filter = compose(filter, plus(3 * t, 48 * U));
  filter = compose(filter, 8 * U); // prior conversion and scaling
  filter = compose(filter, 8 * U); // final assembled filter * cohort product
  // Per small frequency: <=1000 aliases per cohort, <=4 cohorts. Generic
  // sequential addition gamma_4000; magnitude sum <=sqrt(1000)<32.
  const addition = up(4000 * U / (1 - 4000 * U));
  const fold = plus(times(4000, times(filter, plus(1, error))), times(32, times(addition, plus(1, error))));
  let inverse = 0;
  for (let i = 0; i < 9; i++) inverse = compose(inverse, stage);
  inverse = compose(inverse, U);
  // Exact folded coefficients have magnitude <=1. Raw coefficient errors
  // accumulate with sum|W|<32; folding arithmetic adds its own error. Feed
  // that entire perturbed-input bound into the inverse rounding estimate.
  const inverseInput = plus(1, plus(times(32, error), fold));
  const numeric = plus(times(1698, error), plus(times(54, fold), times(2880, times(inverse, inverseInput))));
  // Positive clipping is nonexpansive; excess trimming can cost numeric
  // once again. Final Q63 floor and binary64 conversion are separate.
  // Subnormal absolute errors: <2^31 raw operations, <2^53 multiplicity,
  // and <2^44 for two raw-grid norm amplifications give <2^-946.
  // 2^-900 also covers the additional constant factors in accepted E<2.
  // At most2880 inverse cells plus four exact point-cohort priors are
  // floored before integer merging/trimming; merging creates no new error.
  return Math.min(2, plus(times(2, numeric), plus(plus(2884 / 2 ** 63, U), 2 ** -900)));
}

export function deriveSpectralBounds(
  descriptor: JointSourceDescriptor, priors: readonly Q[], stock: Triple, budget: CertifiedEvidenceBudget,
  observeWork?: (work: Readonly<SpectralHostWork>) => void,
  remainingRawWork = SPECTRAL_RAW_WORK_LIMIT,
): SpectralBoundsResult {
  if (!Number.isSafeInteger(remainingRawWork) || remainingRawWork < 0 || remainingRawWork > SPECTRAL_RAW_WORK_LIMIT)
    throw new RangeError("spectral_remaining_work_invalid");
  let workspace = 0;
  const work: SpectralHostWork = { hostScalarOps: 0, hostStateVisits: 0, hostIntegerOps: 0 };
  const previousWork = activeWork, previousRemaining = remainingWork;
  activeWork = work;
  remainingWork = remainingRawWork;
  const result: SpectralDateBound[] = [{ window: [0, 0, 0], sourceL1Upper: 0 }];
  const fallbackWindow: Triple = [-stock[0] % 10, -stock[1] % 10, -stock[2] % 10];
  try {
    if ((descriptor.cohortCount !== 3 && descriptor.cohortCount !== 4) || priors.length !== descriptor.cohortCount)
      throw new Error("joint_source_plan_invalid");
    // Even the initial charge must be inside this observer/cleanup scope:
    // a retry can have fewer than six raw operations left.
    charge("hostScalarOps", 6);
    workspace = SPECTRAL_BOUNDS_WORKSPACE_BYTES;
    budget.reserve(workspace);
    let references = 0;
    for (const event of descriptor.events) { charge("hostScalarOps"); references += event.refs.length; }
    // Reserve the unique-ID traversal before allocating its Set, then reserve
    // model caches before constructing any cohort model.
    charge("hostScalarOps", 2);
    const traversalBytes = references * 128;
    workspace += traversalBytes;
    budget.reserve(traversalBytes);
    const required = spectralBoundsWorkspaceBound(descriptor.laws, descriptor.events);
    charge("hostScalarOps");
    const modelBytes = required - workspace;
    workspace = required;
    budget.reserve(modelBytes);
    const check = () => { charge("hostStateVisits"); budget.check(); };
    const cache = new Map<string, Model>();
    let dispatch: Raw[][] | undefined;
    // The preceding model reservation includes these request-owned tables.
    let dispatchFactors: Float64Array | undefined;
    const zs = Array.from({ length: 96 }, (_, i) => { charge("hostScalarOps", 2); return (i + 32) / 64; }).filter((z) => z !== 1);
    charge("hostStateVisits", 3 * zs.length);
    const lastThreshold = new Float64Array(zs.length).fill(NaN), denominators = new Float64Array(zs.length);
    const get = (id: string, c: number): Model => {
      const key = `${id}:${c}`;
      const cached = cache.get(key); if (cached) return cached;
      const finite = descriptor.laws.find((law) => law.id === id && law.kind === "finite");
      let rows: Raw[];
      if (finite) {
        rows = [];
        for (const row of finite.outcomesByCohort ? finite.outcomesByCohort[c]! : finite.outcomes!) {
          check();
          // Descriptor WireQ is already validated. Avoid an unnecessary gcd
          // normalization (and its hidden arbitrary-precision work).
          charge("hostIntegerOps", 2);
          const mass = { n: BigInt(row.mass.numerator), d: BigInt(row.mass.denominator) };
          if (mass.n > 0n) rows.push({ raw: [...row.pieces, 0, 0], mass: rationalUpper(mass) });
        }
      }
      else if (id === "dispatch-board-v1") {
        dispatch ??= dispatchModels(priors.length, check); rows = dispatch[c]!;
        if (!dispatchFactors) {
          const slots = LOOSE_EXPONENTS * BOX_EXPONENTS * BOX_EXPONENTS;
          charge("hostStateVisits", slots);
          dispatchFactors = new Float64Array(slots);
        }
      }
      else if (id === "regular-box-v1" || id === "box-ii-v1") rows = (id === "regular-box-v1" ? BOX_LAWS.regular : BOX_LAWS.boxII).map((r) => ({ raw: [...r.pieces, 0, 0], mass: rationalUpper(r.mass) }));
      else {
        const match = /^deterministic:(\d+),(\d+),(\d+)$/.exec(id);
        if (!match) throw new Error("joint_source_plan_invalid");
        charge("hostIntegerOps", 3);
        rows = [{ raw: [Number(match[1]), Number(match[2]), Number(match[3]), 0, 0], mass: 1 }];
      }
      const value = model(rows, check, !finite && id === "dispatch-board-v1" ? dispatchFactors : undefined);
      cache.set(key, value); return value;
    };
    const counts = new Map<string, number>();
    for (let day = 1; day <= 14; day++) {
      for (const event of descriptor.events) if (event.day === day) for (const ref of event.refs) {
        charge("hostStateVisits"); charge("hostScalarOps");
        counts.set(ref.lawId, (counts.get(ref.lawId) ?? 0) + ref.count);
      }
      const entries = [...counts].filter(([, n]) => n > 0);
      const byCohort = priors.map((_, c) => entries.map(([id, n]) => ({ law: get(id, c), n })));
      let draws = 0;
      for (const [id, n] of entries) if (byCohort.some((_, c) => { const m = get(id, c); return m.min.some((v, k) => v !== m.max[k]); })) { charge("hostScalarOps"); draws += n; }
      const windows = [0, 0, 0];
      const tails = priors.map(() => 0);
      for (let axis = 0; axis < 3; axis++) {
        check();
        const mins = byCohort.map((laws) => laws.reduce((s, { law, n }) => { charge("hostScalarOps", 2); return s + law.min[axis]! * n; }, 0));
        const maxs = byCohort.map((laws) => laws.reduce((s, { law, n }) => { charge("hostScalarOps", 2); return s + law.max[axis]! * n; }, 0));
        const means = byCohort.map((laws) => laws.reduce((s, { law, n }) => { charge("hostScalarOps", 2); return s + law.mean[axis]! * n; }, 0));
        const width = SPECTRAL_GRID[axis]!;
        if (![...mins, ...maxs].every(Number.isSafeInteger)) { tails.fill(1); windows[axis] = fallbackWindow[axis]!; continue; }
        // Candidate ratios are exact binary rationals; choice affects tightness,
        // never validity. Search all aligned origins near cohort means/support.
        const mgfs = byCohort.map((laws) => zs.map((z) => {
          let product = 1;
          for (const { law, n } of laws) { check(); product = times(product, pow(moment(law, axis, z, check), n)); }
          return product;
        }));
        charge("hostScalarOps", 3); // subtraction and floor/ceil search-center bounds
        const lower = Math.max(0, Math.floor(Math.min(...means) - width));
        const upper = Math.max(lower, Math.ceil(Math.max(...means)));
        // Bound search cardinality for adversarial finite law magnitudes.
        const centers = new Set<number>();
        const addCenter = (x: number) => {
          charge("hostScalarOps");
          const floored = Math.floor(x);
          if (!Number.isFinite(x) || !Number.isSafeInteger(floored)) return;
          charge("hostIntegerOps", 9); // conservative maximum, including the negative quotient branch
          const shifted = BigInt(floored) + BigInt(stock[axis]!);
          const quotient = shifted >= 0n ? shifted / 10n : (shifted - 9n) / 10n;
          const origin = Number(10n * quotient - BigInt(stock[axis]!));
          if (Number.isSafeInteger(origin)) centers.add(origin);
        };
        charge("hostScalarOps");
        if (upper - lower <= 20_000) {
          charge("hostScalarOps", 2);
          const end = upper + 10;
          for (let x = lower - 10; x <= end;) {
            addCenter(x);
            charge("hostScalarOps"); x += 10;
          }
        }
        for (const x of [...mins, ...means, ...maxs.map((v) => { charge("hostScalarOps", 2); return v - width + 1; })]) addCenter(x);
        let best = Infinity, chosen = fallbackWindow[axis]!, chosenTails = priors.map(() => 1);
        for (const origin of centers) {
          const perCohort = priors.map((_, c) => {
            const tail = (threshold: number, high: boolean) => {
              if (high ? threshold > maxs[c]! : threshold < mins[c]!) return 0;
              if (high ? threshold <= mins[c]! : threshold >= maxs[c]!) return 1;
              let value = 1;
              for (let j = 0; j < zs.length; j++) {
                const z = zs[j]!; if ((z > 1) !== high) continue;
                check();
                // z and the integer threshold fully determine this downward
                // enclosure. Only the numerator depends on the cohort.
                charge("hostStateVisits", 2);
                if (lastThreshold[j] !== threshold) {
                  charge("hostStateVisits", 2);
                  denominators[j] = threshold >= 0 ? pow(z, threshold, false) : down(1 / pow(z, -threshold));
                  lastThreshold[j] = threshold;
                }
                const denom = denominators[j]!;
                const numerator = mgfs[c]![j]!;
                if (denom > 0 && Number.isFinite(numerator)) value = Math.min(value, up(numerator / denom));
              }
              return value;
            };
            charge("hostScalarOps", 2);
            return Math.min(1, plus(tail(origin - 1, false), tail(origin + width, true)));
          });
          let score = 0;
          for (let c = 0; c < priors.length; c++) score = plus(score, times(rationalUpper(priors[c]!), perCohort[c]!));
          if (score < best) { best = score; chosen = origin; chosenTails = perCohort; }
        }
        windows[axis] = chosen;
        for (let c = 0; c < tails.length; c++) tails[c] = plus(tails[c]!, chosenTails[c]!);
      }
      let alias = 0;
      for (let c = 0; c < priors.length; c++) alias = plus(alias, times(rationalUpper(priors[c]!), Math.min(1, tails[c]!)));
      result.push({ window: windows as unknown as Triple, sourceL1Upper: Math.min(2, plus(times(2, alias), spectralNumericalBound(draws))) });
    }
    return { dates: result, performedWork: work.hostScalarOps + work.hostStateVisits + work.hostIntegerOps, work };
  } catch (error) {
    if (!(error instanceof BoundWorkLimit)) throw error;
    // Full L1 between probabilities is at most two. This is a genuine
    // unavailable-future certificate, never a fabricated numerical success.
    while (result.length < 15) result.push({ window: fallbackWindow, sourceL1Upper: 2 });
    return { dates: result, performedWork: work.hostScalarOps + work.hostStateVisits + work.hostIntegerOps, work };
  } finally {
    activeWork = previousWork;
    remainingWork = previousRemaining;
    try {
      // Request-owned observers must not throw. Copy/freeze prevents retained
      // diagnostics from mutating this attempt's result or later attempts.
      observeWork?.(Object.freeze({ ...work }));
    } finally {
      budget.release(workspace);
    }
  }
}
