import type { CertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity";
import { add, eq, fromWire, ONE, type Q, toWire, ZERO } from "../../shared/certifiedRational";
import { BOX_LAWS, DISPATCH_CLASSES, type CertifiedSupplyLaw, type Triple } from "../../shared/certifiedSupplyLaws";
import { certifiedVersionPolicy } from "../../shared/certifiedVersionPolicy";
import { eventOffset, futureEvents } from "../certified/events";
import { CAPS, encode, KIT_INDICES, type KitIndex, type Units } from "../certified/game";
import type { CertifiedEvidenceBudget, CertifiedInput } from "../certified/types";
import { validate } from "../certified/validation";
import { liveJsonWorkspace } from "../certifiedRecommendation/liveRuntime";
import type { JointDatePlan, JointSourceCertificate, JointSourceDescriptor, JointSourcePlan, PositiveZeroKitWitness, ServiceH14Input } from "./types";
import { deriveSpectralBounds, SPECTRAL_RAW_WORK_LIMIT } from "./spectralBounds";
import { balancedThresholdTicks } from "./balancedThreshold.ts";
import { positiveZeroKitWitness } from "./supportProof";

export const JOINT_SOURCE_ALGORITHM = "joint-spectral-mixture-v3" as const;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PREPARATION_WORKSPACE_BYTES = 131072;

/** Maximum simultaneous reservation made by prepareJointSourcePlan, including
 * its retained plan at return. Each of the fifteen metadata-only dates (at
 * most four cohorts) fits 64KiB under liveJsonWorkspace's fixed scalar widths.
 * One more 64KiB covers plan/descriptor wrappers, compiled dispatch classes,
 * default priors and 64-character hashes. Laws, filtered event refs and any
 * explicit prior digits are bounded by the original input workspace. Hash
 * workspaces and retained-plan reservation do not overlap. Spectral work is
 * deferred until after Current and owns a separate future-phase reservation. */
export function jointSourcePlanWorkspaceBound(input: CertifiedInput): number {
  const inputBytes = liveJsonWorkspace(input);
  const outer = 2 * inputBytes + PREPARATION_WORKSPACE_BYTES;
  const nestedOrRetained = inputBytes + 16 * 65536;
  const bound = outer + nestedOrRetained;
  if (!Number.isSafeInteger(bound)) throw new Error("joint_source_plan_workspace");
  return bound;
}
type BigTriple = [bigint, bigint, bigint];
type LawSupport = { min: Triple; max: Triple };
const triple = (f: (k: KitIndex) => number): Triple => [f(0), f(1), f(2)];
const bigTriple = (f: (k: KitIndex) => bigint): BigTriple => [f(0), f(1), f(2)];
const min = (a: bigint, b: bigint) => a < b ? a : b;
function invalid(): never { throw new Error("joint_source_plan_invalid"); }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
}
async function hash(value: unknown, budget: CertifiedEvidenceBudget): Promise<string> {
  const bytes = liveJsonWorkspace(value);
  try {
    budget.reserve(bytes);
    budget.check();
    const encoded = new TextEncoder().encode(JSON.stringify(canonical(value)));
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    budget.check();
    return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
  } finally { budget.release(bytes); }
}

/** Pure support only: no JS daily probability tables or dispatch enumeration.
 * Every positive-weight class can fill all four slots. For any reroll cohort,
 * an all-discard board followed by that board has positive probability. Thus
 * these coordinate extrema describe FULL support, not retained Q63 atoms. */
function dispatchSupport(): LawSupport {
  const minima: Units = [Infinity, Infinity, Infinity];
  const maxima: Units = [0, 0, 0];
  for (const cls of DISPATCH_CLASSES) {
    if (cls.weight <= 0) continue;
    for (const k of KIT_INDICES) {
      const lo = cls.raw[k] + cls.raw[3] * Math.min(...BOX_LAWS.regular.map((r) => r.pieces[k])) +
        cls.raw[4] * Math.min(...BOX_LAWS.boxII.map((r) => r.pieces[k]));
      const hi = cls.raw[k] + cls.raw[3] * Math.max(...BOX_LAWS.regular.map((r) => r.pieces[k])) +
        cls.raw[4] * Math.max(...BOX_LAWS.boxII.map((r) => r.pieces[k]));
      minima[k] = Math.min(minima[k], 4 * lo);
      maxima[k] = Math.max(maxima[k], 4 * hi);
    }
  }
  const lo = triple((k) => minima[k]);
  const hi = triple((k) => maxima[k]);
  return { min: lo, max: hi };
}

function support(id: string, cohort: number, laws: readonly CertifiedSupplyLaw[], budget: CertifiedEvidenceBudget): LawSupport {
  budget.check();
  // Same precedence as Supply::law: finite even overrides a builtin/deterministic ID.
  const finite = laws.find((law) => law.id === id && law.kind === "finite");
  if (finite) {
    const rows = finite.outcomesByCohort ? finite.outcomesByCohort[cohort] : finite.outcomes;
    if (!rows?.length || rows.length > 25_000) invalid();
    let total = ZERO;
    let positive = 0n;
    const lo: Units = [Infinity, Infinity, Infinity], hi: Units = [0, 0, 0];
    for (const row of rows) {
      budget.check();
      const p = fromWire(row.mass);
      if (p.n < 0n || row.pieces.some((n) => !Number.isSafeInteger(n) || n < 0)) invalid();
      total = add(total, p);
      if (p.n === 0n) continue;
      positive++;
      for (const k of KIT_INDICES) { lo[k] = Math.min(lo[k], row.pieces[k]); hi[k] = Math.max(hi[k], row.pieces[k]); }
    }
    if (!eq(total, ONE) || positive === 0n) invalid();
    return { min: triple((k) => lo[k]), max: triple((k) => hi[k]) };
  }
  if (id === "dispatch-board-v1") return dispatchSupport();
  const box = id === "regular-box-v1" ? BOX_LAWS.regular : id === "box-ii-v1" ? BOX_LAWS.boxII : null;
  if (box) return { min: triple((k) => Math.min(...box.map((r) => r.pieces[k]))),
    max: triple((k) => Math.max(...box.map((r) => r.pieces[k]))) };
  const match = /^deterministic:(\d+),(\d+),(\d+)$/.exec(id);
  if (!match) invalid();
  const pieces = triple((k) => Number(match[k + 1]));
  if (pieces.some((n) => !Number.isSafeInteger(n) || n < 0)) invalid();
  return { min: pieces, max: pieces };
}


export async function prepareJointSourcePlan(
  input: ServiceH14Input, forecastIdentity: CertifiedForecastIdentity, sid: number,
  priors: readonly Q[], budget: CertifiedEvidenceBudget,
): Promise<JointSourcePlan> {
  // Validation remains independent on Client and Worker. No supplied plan or
  // source diagnostics can authorize a smaller error envelope.
  const workspace = 2 * liveJsonWorkspace(input) + PREPARATION_WORKSPACE_BYTES;
  try {
    budget.reserve(workspace);
    budget.check();
    const expected = validate(input, () => budget.check());
    const cohortCount = certifiedVersionPolicy(input.snapshot.version).cohortCount;
    const unitCaps = CAPS[sid];
    if (sid !== encode(input.grade, input.level, input.exp) || !unitCaps ||
      priors.length !== cohortCount || expected.some((p, c) => !priors[c] || !eq(p, priors[c])) ||
      !/^[a-f0-9]{64}$/.test(forecastIdentity.snapshotHash)) invalid();
    const stock = triple((k) => input.stock[k]);
    const caps = bigTriple((k) => min(SAFE, 10n * BigInt(unitCaps[k])));
    const d0Only = input.legacyD0 !== undefined;
    const events = d0Only ? [] : futureEvents(input).map((event) => ({ day: eventOffset(input, event), refs: event.refs }));
    const descriptor: JointSourceDescriptor = {
      snapshotVersion: input.snapshot.version, dependence: "independent-days-given-cohort",
      cohortCount, events, laws: input.snapshot.laws,
    };
    const sourceKey = await hash({ algorithm: JOINT_SOURCE_ALGORITHM, sourceIdentity: forecastIdentity.snapshotHash,
      descriptor, priors: priors.map(toWire), dispatchClasses: DISPATCH_CLASSES }, budget);
    const pieceCaps = triple((k) => Number(caps[k]));
    const projectionKey = await hash({ sourceKey, sid, stock, pieceCaps }, budget);
    const states = Array.from({ length: cohortCount }, () => ({
      rawMin: bigTriple(() => 0n), rawMax: bigTriple(() => 0n),
    }));
    const cache = new Map<string, LawSupport>();
    const thresholds = d0Only ? [50] : balancedThresholdTicks(descriptor, priors, () => budget.check());
    const dates: JointDatePlan[] = [];
    let prefixKey = projectionKey;
    for (let day = 0; day < thresholds.length; day++) {
      budget.check();
      const todays = events.filter((event) => event.day === day);
      for (const event of todays) for (const ref of event.refs) {
        const times = BigInt(ref.count);
        if (!times) continue;
        for (const [c, state] of states.entries()) {
          const key = JSON.stringify([ref.lawId, c]);
          let law = cache.get(key);
          if (!law) { law = support(ref.lawId, c, descriptor.laws, budget); cache.set(key, law); }
          for (const k of KIT_INDICES) {
            state.rawMin[k] += times * BigInt(law.min[k]);
            state.rawMax[k] += times * BigInt(law.max[k]);
          }
        }
      }
      prefixKey = await hash({ prefixKey, day, events: todays }, budget);
      const cohorts = states.map((state) => {
        const lo = triple((k) => Math.floor(Number(min(caps[k], BigInt(stock[k]) + state.rawMin[k])) / 10));
        const hi = triple((k) => Math.floor(Number(min(caps[k], BigInt(stock[k]) + state.rawMax[k])) / 10));
        return {
          rawMin: triple((k) => Number(min(SAFE, state.rawMin[k]))),
          rawMax: triple((k) => Number(min(SAFE, state.rawMax[k]))),
          rawOverflow: KIT_INDICES.some((k) => state.rawMax[k] > SAFE || state.rawMax[k] + BigInt(stock[k]) > SAFE),
          minUnits: lo, maxUnits: hi,
        };
      });
      dates.push({ day, thresholdTicks: thresholds[day]!, prefixKey, cohorts,
        minUnits: triple((k) => Math.min(...cohorts.map((c) => c.minUnits[k]))),
        maxUnits: triple((k) => Math.max(...cohorts.map((c) => c.maxUnits[k]))),
        window: day === 0 ? [0, 0, 0] : triple(k => -(stock[k] % 10)), sourceL1Upper: day === 0 ? 0 : 2,
        positiveZeroKitCohort: null });
    }
    const plan: JointSourcePlan = { algorithm: JOINT_SOURCE_ALGORITHM, streamKind: "prior-mixture", sourceIdentity: forecastIdentity.snapshotHash,
      sourceKey, projectionKey, snapshotVersion: input.snapshot.version, cohortCount, sid, stock, pieceCaps,
      maxUnits: triple((k) => Math.max(...dates.map((d) => d.maxUnits[k]))), descriptor, dates,
      spectralCertified: false, hostPerformedWork: 0, hostWork: { hostScalarOps: 0, hostStateVisits: 0, hostIntegerOps: 0 } };
    // The plan stays live through streaming/binding. The owner retires its
    // request budget as a whole; only temporary hashing/validation is released.
    const retainedBytes = liveJsonWorkspace(plan);
    try { budget.reserve(retainedBytes); }
    catch (error) { budget.release(retainedBytes); throw error; }
    return plan;
  } finally { budget.release(workspace); }
}

/** Future-only work: never run during admission or validation of exact Current.
 * A failed reservation/deadline leaves the conservative pending plan intact.
 * Cancellation and the original request deadline propagate without suppression. */
export function certifyJointSourcePlan(plan: JointSourcePlan, priors: readonly Q[], budget: CertifiedEvidenceBudget): void {
  budget.check();
  if (plan.spectralCertified) return;
  const scalarBefore=plan.hostWork.hostScalarOps,stateBefore=plan.hostWork.hostStateVisits,integerBefore=plan.hostWork.hostIntegerOps;
  const spectral = deriveSpectralBounds(plan.descriptor, priors, plan.stock, budget, work => {
    // The helper calls this exactly once from finally, even on cancellation.
    // No allocation, validation or budget check can replace the original error.
    plan.hostWork.hostScalarOps=scalarBefore+work.hostScalarOps;
    plan.hostWork.hostStateVisits=stateBefore+work.hostStateVisits;
    plan.hostWork.hostIntegerOps=integerBefore+work.hostIntegerOps;
    plan.hostPerformedWork=plan.hostWork.hostScalarOps+plan.hostWork.hostStateVisits+plan.hostWork.hostIntegerOps;
  },Math.max(0,SPECTRAL_RAW_WORK_LIMIT-plan.hostPerformedWork));
  budget.check();
  // Physical witness work runs after Current but BEFORE native source begin,
  // so native receives the full host debit. This is request-local evidence;
  // no global law cache or approximate source row participates.
  let proofWork=0;
  const remaining=Math.max(0,SPECTRAL_RAW_WORK_LIMIT-plan.hostPerformedWork);
  const unavailable={};
  const charge=(operations:number)=>{
    if(operations>remaining-proofWork)throw unavailable;
    proofWork+=operations;
  };
  // Witness cohort slots were reserved with the original metadata plan.
  // Null and number have identical workspace size, so its owner/release
  // contract stays fixed across certification. Only construction is temporary.
  const proofBytes=4096;
  try{
    budget.reserve(proofBytes);
    const witnesses:(PositiveZeroKitWitness|undefined)[]=[];
    for(let day=1;day<=14;day++){
      budget.check();
      try{witnesses[day]=positiveZeroKitWitness(plan,day,priors,budget,charge);}
      catch(error){if(error!==unavailable)throw error;break;}
    }
    for(let day=1;day<=14;day++){
      const date=plan.dates[day]!,bound=spectral.dates[day]!;
      date.window=bound.window;date.sourceL1Upper=bound.sourceL1Upper;
      const witness=witnesses[day];
      date.positiveZeroKitCohort=witness?.cohort??null;
    }
  }finally{
    // Account actual work even on cancellation/refusal; never mask the cause.
    plan.hostWork.hostScalarOps+=proofWork;
    plan.hostPerformedWork=plan.hostWork.hostScalarOps+plan.hostWork.hostStateVisits+plan.hostWork.hostIntegerOps;
    budget.release(proofBytes);
  }
  plan.spectralCertified = true;
}

export function deriveJointSourceCertificate(plan: JointSourcePlan, throughDay: number, budget: CertifiedEvidenceBudget): JointSourceCertificate {
  budget.check();
  if (!Number.isInteger(throughDay) || throughDay < 0 || throughDay >= plan.dates.length || throughDay > 14) invalid();
  if (throughDay > 0 && !plan.spectralCertified) throw new Error("joint_source_certificate_not_ready");
  // The enclosing output owner already reserves retained response capacity.
  // This covers construction even for independent Client comparison calls.
  const workspace = 4096 + (throughDay + 1) * (512 + 64 * plan.cohortCount);
  try {
    budget.reserve(workspace);
    const result: JointSourceCertificate = {
      algorithm: JOINT_SOURCE_ALGORITHM, streamKind: "prior-mixture", normalization: "subprobability", sourceKey: plan.sourceKey,
      projectionKey: plan.projectionKey, cohortCount: plan.cohortCount, completedThrough: throughDay,
      days: plan.dates.slice(0, throughDay + 1).map((d) => ({ day: d.day, prefixKey: d.prefixKey,
        window: [...d.window], sourceL1Upper: d.sourceL1Upper })),
    };
    budget.check();
    return result;
  } finally { budget.release(workspace); }
}

export function assertJointSourceCertificate(actual: unknown, plan: JointSourcePlan, throughDay: number, budget: CertifiedEvidenceBudget): void {
  const workspace = 32768;
  try {
    budget.reserve(workspace);
    const expected = deriveJointSourceCertificate(plan, throughDay, budget);
    const same = (a: unknown, e: unknown): boolean => {
      budget.check();
      if (!e || typeof e !== "object") return a === e;
      if (!a || typeof a !== "object" || Array.isArray(a) !== Array.isArray(e)) return false;
      if (Array.isArray(e) && (!Array.isArray(a) || a.length !== e.length)) return false;
      const keys = Object.keys(e);
      let count = 0;
      // Do not allocate an attacker-sized Object.keys(actual) array.
      for (const key in a) {
        budget.check();
        if (!Object.hasOwn(a, key)) continue;
        if (++count > keys.length || !Object.hasOwn(e, key)) return false;
      }
      return count === keys.length && keys.every((key) => Object.hasOwn(a, key) &&
        same(Reflect.get(a, key), Reflect.get(e, key)));
    };
    if (!same(actual, expected)) throw new Error("joint_source_certificate_mismatch");
  } finally { budget.release(workspace); }
}

/** Bind the plan to what Kernel.prepare actually configured, not merely to
 * begin's echoed hashes. The native producer still evaluates its own Supply;
 * this guard never supplies evaluated law masses or a replacement model. */
export function assertJointSourceModelBinding(
  plan: JointSourcePlan, preparedInput: CertifiedInput, budget: CertifiedEvidenceBudget,
): void {
  const workspace = 2 * liveJsonWorkspace(preparedInput);
  try {
    budget.reserve(workspace);
    budget.check();
    const expected: JointSourceDescriptor = {
      snapshotVersion: preparedInput.snapshot.version,
      dependence: "independent-days-given-cohort",
      cohortCount: certifiedVersionPolicy(preparedInput.snapshot.version).cohortCount,
      events: futureEvents(preparedInput).map((event) => ({ day: eventOffset(preparedInput, event), refs: event.refs })),
      laws: preparedInput.snapshot.laws,
    };
    if (plan.sid !== encode(preparedInput.grade, preparedInput.level, preparedInput.exp) ||
      plan.stock.some((n, k) => n !== preparedInput.stock[k]) ||
      JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(plan.descriptor)))
      throw new Error("joint_source_model_binding_mismatch");
    budget.check();
  } finally { budget.release(workspace); }
}
