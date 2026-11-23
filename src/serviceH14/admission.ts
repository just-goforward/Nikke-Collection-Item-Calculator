import { rootCandidate } from "../lib/rootCandidate";
import { nextReceiptPhase } from '../../shared/receiptClock.ts';
import { matchesPortableLaw } from './portableLaw.ts';
import { openPortableToll, type PortableQuery } from './portableToll.ts';
import { portablePath,portablePin } from './portablePins.ts';
import type { CertifiedForecastIdentity } from '../../shared/certifiedForecastIdentity.ts';
import type { Q } from '../../shared/certifiedRational.ts';
import { assertTrustedCertifiedForecast, assertTrustedPreviewLegacyD0, trustedCertifiedForecastWorkspaceBound } from '../lib/certifiedForecastTrust.ts';
import { previewLegacyD0Enabled } from '../lib/runtimeForecastConfig.ts';
import { PREVIEW_TIMED_FEED, previewHeadLease } from '../lib/forecastRead.ts';
import { PreviewSourceError } from '../lib/previewSourceError.ts';
import { GAME_DAY_MS, gameDayStartMs } from '../../shared/gameDay.ts';
import { validate } from '../certified/validation.ts';
import { encode } from '../certified/game.ts';
import { jointSourcePlanWorkspaceBound, prepareJointSourcePlan } from './sourcePlan.ts';
import { liveJsonWorkspace } from '../certifiedRecommendation/liveRuntime.ts';
import type { JointSourcePlan, ServiceH14Input } from './types.ts';

export const INPUT_SCAN_BYTES = 65_536;
export const INPUT_JSON_CEILING = 2 * 1024 * 1024;
export type ServiceH14Admission = {
  forecastIdentity: CertifiedForecastIdentity;
  inputSha256: string;
  plan: JointSourcePlan;
  priors: readonly Q[];
  readonly portableToll?:PortableQuery;
  /** Monotonic, locally observed minimum of the authenticated OFF and legacy head leases. */
  readonly conditionalUntil?: number;
  readonly legacyLeaseUntil?:  number;
  /** Outstanding owned plan plus admission metadata, not temporary preparation capacity. */
  readonly retainedBytes: number;
  /** Retire this reservation only after the request stops using its plan and binding metadata. */
  release(): void;
};
const INPUT_KEYS: Readonly<Record<string, true>> = { grade:true, level:true, exp:true, stock:true, asOf:true, snapshot:true, forecastPublication:true, forecastSource:true, cohortWeights:true, receivedEventIds:true, priceParent:true, priceBasisStock:true, computeWaiting:true, computeMinimumWait:true, batchLimit:true, autoRecommendation:true, riskSummary:true, stableRecommendation:true, target:true, legacyD0:true, previewJoint:true };

/** Descriptor-only bounded traversal before stringify, key arrays, schema validation or await. */
export function scanServiceJson(value: unknown, check: () => void, ceiling = INPUT_JSON_CEILING): number {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const charge = (amount: number) => { bytes += amount; if (bytes > ceiling) throw new Error('service_h14_json_ceiling'); };
  const visit = (item: unknown, depth: number): void => {
    check();
    if (++nodes > 65_536 || depth > 24) throw new Error('service_h14_tree_ceiling');
    if (item === null || typeof item === 'boolean') { charge(8); return; }
    if (typeof item === 'string') { charge(2 + 6 * item.length); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { charge(32); return; }
    if (typeof item !== 'object' || item === null) throw new Error('service_h14_json_type');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) || ancestors.has(item)) throw new Error('service_h14_json_shape');
    ancestors.add(item); charge(64);
    let count = 0;
    for (const key in item) {
      check();
      if (!Object.hasOwn(item,key) || ++count > 16_384 || key.length > 256 || (array && key !== String(count - 1))) throw new Error('service_h14_json_keys');
      const descriptor = Object.getOwnPropertyDescriptor(item,key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('service_h14_json_accessor');
      charge(64 + 6 * key.length);
      if (descriptor.value !== undefined || array) visit(descriptor.value,depth + 1);
    }
    if ((array && count !== item.length) || Reflect.ownKeys(item).length !== count + (array ? 1 : 0)) throw new Error('service_h14_json_hidden');
    ancestors.delete(item);
  };
  visit(value,0);
  return bytes;
}

function inputShape(input: ServiceH14Input): void {
  for (const key of Object.keys(input)) if (!Object.hasOwn(INPUT_KEYS,key)) throw new Error('service_h14_input_key');
  if (rootCandidate && !input.previewJoint) throw Error('production_conditional_required');
  if (import.meta.env?.BASE_URL === '/preview/' && (!input.forecastPublication || input.forecastSource !== undefined))
    throw new Error('certified_forecast_not_approved');
  if (input.autoRecommendation === true || input.stableRecommendation !== undefined || input.target !== undefined) throw new Error('service_h14_legacy_policy');
  if (input.computeWaiting !== undefined && typeof input.computeWaiting !== 'boolean') throw new Error('service_h14_wait_option');
  if(Object.hasOwn(input,'previewJoint')) {
    const proof=input.previewJoint;
    if(!proof || Object.keys(proof).length!==1 || (rootCandidate ? proof.timedOff!==null : (!previewLegacyD0Enabled || proof.timedOff?.artifact!==null)) || !input.forecastPublication?.artifact || input.forecastSource!==undefined || input.legacyD0!==undefined || input.cohortWeights!==undefined || input.computeWaiting!==true || input.computeMinimumWait!==false) throw Error('preview_joint_scope');
    // Elapsed conditional occurrences are not claim history. They never enter futureEvents.
    if(input.receivedEventIds?.length)throw Error('preview_joint_receipts');
  }
  if (Object.hasOwn(input,'legacyD0')) {
    const proof = input.legacyD0;
    if (!previewLegacyD0Enabled || !proof || Object.keys(proof).length !== 1 || !proof.timedOff ||
        proof.timedOff.artifact !== null || typeof proof.timedOff.pointer?.statement !== 'string' ||
        proof.timedOff.pointer.statement.length > 2048 || proof.timedOff.pointer.signature?.length !== 88 ||
        !input.forecastPublication?.artifact || input.forecastSource !== undefined || input.computeWaiting !== false ||
        input.computeMinimumWait !== false || input.cohortWeights !== undefined || input.priceParent !== undefined || input.priceBasisStock !== undefined ||
        gameDayStartMs(Date.parse(input.asOf)) !== gameDayStartMs(Date.now())) throw new Error('service_h14_legacy_d0_scope');
  }
}

function canonical(value: unknown, check: () => void): unknown {
  check();
  if (Array.isArray(value)) return value.map(item => canonical(item,check));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string,unknown>)[key] !== undefined)
    .map(key => [key,canonical((value as Record<string,unknown>)[key],check)]));
}

function admissionWorkspace(input: ServiceH14Input, check: () => void) {
  const bytes = scanServiceJson(input,check);
  inputShape(input);
  // Fixed metadata and exact prior limbs coexist with each preparation phase.
  // Input workspace bounds explicit priors; it is not a second copy of the input.
  const baseBytes = INPUT_SCAN_BYTES + liveJsonWorkspace(input);
  const trustBytes = trustedCertifiedForecastWorkspaceBound(input.snapshot,input.forecastPublication,input.forecastSource) +
    (input.previewJoint ? 2*1024*1024 : input.legacyD0 ? 65_536 : 0); // bounded OFF envelope + sequential 4 KiB primary version reads
  const hashBytes = 6 * bytes;
  const planBytes = jointSourcePlanWorkspaceBound(input);
  const asset=input.exp===0&&input.computeWaiting!==false&&input.forecastPublication?.artifact&&!input.previewJoint&&!input.legacyD0?
    portablePin(encode(input.grade,input.level,input.exp),input.stock):null;
  // The plan build workspace is already released when decoding starts. Never
  // charge its peak concurrently or reserve over the client's clone capacity.
  const tollPeak=asset?9*1024**2:0;
  const peakBytes = Math.max(tollPeak,baseBytes + Math.max(trustBytes,hashBytes,planBytes));
  if (!Number.isSafeInteger(peakBytes) || peakBytes > 24 * 1024 * 1024) throw new Error('service_h14_admission_ceiling');
  return { baseBytes,trustBytes,hashBytes,planBytes,peakBytes,tollPeak,asset };
}

/** Caller reserves INPUT_SCAN_BYTES before invoking this synchronous preflight. */
export function serviceH14AdmissionWorkspaceBound(input: ServiceH14Input, check: () => void = () => {}): number {
  return admissionWorkspace(input,check).peakBytes;
}

async function fullInputSha256(input: ServiceH14Input, check: () => void): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical(input,check)));
  const digest = await crypto.subtle.digest('SHA-256',encoded);
  check();
  return Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('');
}

/** A reply can outlive a short primary lease without outliving its compute budget. */
export function previewLeaseLive(until: number | undefined, asOf: string, phaseWallUntil?:number) {
  return (phaseWallUntil===undefined || (Date.now()>=Date.parse(asOf)&&Date.now()<phaseWallUntil)) &&
    (until === undefined || (performance.now() < until && gameDayStartMs(Date.now()) === gameDayStartMs(Date.parse(asOf))));
}

/** Independent authority, full-input hash and source certificate derivation at each boundary.
 * Trust, full-input hashing and source preparation are sequential temporary scopes.
 * Each await retains its full reservation. Success transfers only retained ownership
 * to release(); nested helper finally(0) never clears the outer reservation. */
export async function admitServiceH14Input(input: ServiceH14Input, track: (bytes: number) => void, check: () => void): Promise<ServiceH14Admission> {
  try { return await admitOnce(input,track,check); }
  catch (error) {
    // Repeat only a failed primary read/lease, before dispatch/compute. Keep
    // the same physical request, price seal, input hash contract and budget.
    if (!(error instanceof PreviewSourceError && error.renewable)) throw error;
    check();
    return admitOnce(input,track,check);
  }
}
async function admitOnce(input: ServiceH14Input, track: (bytes: number) => void, check: () => void): Promise<ServiceH14Admission> {
  let transferred = false;
  try {
    track(INPUT_SCAN_BYTES); check();
    const bounds = admissionWorkspace(input,check);
    track(bounds.baseBytes + bounds.trustBytes);
    const priors = validate(input,check);
    const legacy = input.legacyD0 ? await assertTrustedPreviewLegacyD0(input.snapshot,input.legacyD0.timedOff,
      input.forecastPublication!,check,bounds.trustBytes) : undefined;
    const joint = input.previewJoint ? await assertTrustedPreviewLegacyD0(input.snapshot,input.previewJoint.timedOff,input.forecastPublication!,check,bounds.trustBytes,true) : undefined;
    const forecastIdentity = joint?.forecastIdentity ?? legacy?.forecastIdentity ?? await assertTrustedCertifiedForecast(input.snapshot,bytes => {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > bounds.trustBytes) throw new Error('service_h14_trust_workspace');
      check();
    },input.forecastPublication,input.forecastSource);
    const lease = joint ?? legacy;
    const timed = !lease && import.meta.env?.BASE_URL === '/preview/' ? input.forecastPublication : undefined;
    const timedLease = timed ? await previewHeadLease(PREVIEW_TIMED_FEED,timed.pointer) : undefined;
    const until = timedLease?.until ?? lease?.leaseUntil;
    check();
    track(bounds.baseBytes + bounds.hashBytes);
    const inputSha256 = await fullInputSha256(input,check);
    check();
    // Source retains liveJsonWorkspace(plan); its outer validation workspace and
    // nested hash workspaces have distinct reserve/release lifetimes.
    let planBytes = 0;
    track(bounds.baseBytes);
    const plan = await prepareJointSourcePlan(input,forecastIdentity,encode(input.grade,input.level,input.exp),priors,{
      check,
      reserve(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('service_h14_plan_workspace');
        planBytes += bytes;
        if (!Number.isSafeInteger(planBytes) || planBytes > bounds.planBytes) throw new Error('service_h14_plan_workspace');
        track(bounds.baseBytes + planBytes);
        check();
      },
      release(bytes) {
        planBytes -= bytes;
        if (!Number.isSafeInteger(planBytes) || planBytes < 0) throw new Error('service_h14_plan_workspace');
        track(bounds.baseBytes + planBytes);
      },
    });
    check();
    if (planBytes !== liveJsonWorkspace(plan)) throw new Error('service_h14_plan_retained_workspace');
    const metadataBytes = 128 + liveJsonWorkspace({forecastIdentity,inputSha256,priors});
    if (metadataBytes > bounds.baseBytes) throw new Error('service_h14_admission_metadata_workspace');
    let portableToll:PortableQuery|null=null;
    const asset=bounds.asset;
    if(asset&&bounds.tollPeak>=bounds.baseBytes+planBytes+3*asset.bytes+131072){
      track(bounds.tollPeak);
      if(await matchesPortableLaw(input,plan,priors)){
        check();
        const url=(import.meta.env?.BASE_URL??'/')+portablePath(asset);
        const response=await fetch(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(1500)}).catch(()=>null);
        const query=await openPortableToll(response,check,asset);
        if(query){
          // Current is selected later. Evaluate every feasible forced length for
          // this request only, then drop the 1.95 MB slab before Worker cloning.
          const stock=[...input.stock];let waitUpper:number|undefined;
          const scores=stock.map((pieces,k)=>Array.from({length:asset.sid===110?Number(k===2):Math.floor(pieces/10)},(_,j)=>{
            // WAIT depends on the admitted law and stock, not on the forced
            // color/count. Compute its 13 gate panels only once per request.
            const proof=query(asset.sid,stock,k,j+1,check,waitUpper!==undefined);
            if(proof&&'lower' in proof){waitUpper??=proof.upper;proof.upper=waitUpper;}
            return proof;
          }));
          portableToll=(sid,actual,k,n,probe)=>{
            probe();return sid===asset.sid&&stock.length===actual.length&&stock.every((x,i)=>x===actual[i])?scores[k]?.[n-1]??null:null;
          };
        }
      }
      check();
    }
    const retainedBytes = planBytes + metadataBytes + (portableToll?8192:0);
    track(retainedBytes);
    check();
    const asOf=Date.parse(input.asOf);
    const phaseWallUntil=joint?.wallUntil ?? (timed || legacy ?
      input.snapshot.events.reduce((next,e)=>Math.min(next,nextReceiptPhase(asOf,Date.parse(e.at)),
        e.expiresAt && Date.parse(e.expiresAt)>asOf ? Date.parse(e.expiresAt) : Infinity),
        Math.min(gameDayStartMs(asOf)+GAME_DAY_MS,
          input.snapshot.sourceAuthority && input.snapshot.sourceStatus==='healthy'
            ? Date.parse(input.snapshot.sourceAuthority.freshUntil) : Infinity)):undefined);
    const wallUntil = Math.min(lease?.wallUntil ?? timedLease?.wallUntil ?? Infinity, phaseWallUntil ?? Infinity);
    if (until !== undefined && Date.now() < asOf) throw new PreviewSourceError('admission','clock');
    if (!previewLeaseLive(until, input.asOf, until === undefined ? undefined : wallUntil)) throw new PreviewSourceError('admission','expired');
    let released = false;
    const admitted: ServiceH14Admission = {
      forecastIdentity,inputSha256,plan,priors,retainedBytes,
      ...(portableToll?{portableToll}:{}),
      ...(joint ? {conditionalUntil:joint.leaseUntil} : {}),
      ...(legacy ? {legacyLeaseUntil:legacy.leaseUntil} : {}),
      release() {
        if (released) return;
        released = true;
        track(0);
      },
    };
    transferred = true;
    return admitted;
  } finally { if (!transferred) track(0); }
}
