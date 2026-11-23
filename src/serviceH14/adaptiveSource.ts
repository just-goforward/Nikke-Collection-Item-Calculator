import { add, bits, eq, gcd, ONE, ZERO, type Q } from '../../shared/certifiedRational.ts';
import { certifiedCohortWeights, isCertifiedEventClaimable } from '../../shared/certifiedSupply.ts';
import { certifiedSupplyLawPayloadBytes, convolveCertifiedDistributions, getCertifiedLawDistribution, type CertifiedLawRef, type DispatchCohort, type ExactSupplyOutcome, type Triple } from '../../shared/certifiedSupplyLaws.ts';
import { GAME_DAY_MS, gameDayStartMs } from '../../shared/gameDay.ts';
import { eventOffset, futureEvents } from '../certified/events.ts';
import type { CertifiedEvidenceBudget } from '../certified/types.ts';
import type { ServiceH14Admission } from './admission.ts';
import type { ServiceH14Input } from './types.ts';

export class AdaptiveSourceUnavailable extends Error {}
type Admission = Pick<ServiceH14Admission,'plan'|'priors'|'forecastIdentity'|'conditionalUntil'>;
type Atom = {pieces:Triple; masses:Q[]};
type Row = {pieces:Triple; belief:string; weight:bigint};
const MAX_BITS=16384, MAX_RETAINED=32*1024**2, LAW_WORKSPACE=16*1024**2;
function common(d:bigint,v:Q) {
  const denominator=d/gcd(d,v.d)*v.d;
  if(denominator.toString(2).length>MAX_BITS) throw new AdaptiveSourceUnavailable('adaptive_denominator_limit');
  return denominator;
}
function primitive(values:bigint[]) {
  const g=values.reduce(gcd,0n);
  if(!g) throw Error('adaptive_empty_mass');
  return values.map(v=>v/g).join(',');
}

/** Internal only: input must be the request whose signature and plan admission verified.
 * No snapshot, untrusted output or unsigned research fixture is an admission. */
export function createAdaptiveSource(input:ServiceH14Input,{plan,priors,forecastIdentity,conditionalUntil}:Admission,budget:CertifiedEvidenceBudget,horizon=14) {
  const {snapshot}=input, n=plan.cohortCount;
  const check=()=>budget.check(); check();
  const now=Date.parse(input.asOf), reset=gameDayStartMs(now), coverage=snapshot.coverage.future;
  if(input.legacyD0 || !input.forecastPublication?.artifact || input.forecastSource || input.computeWaiting===false ||
    (conditionalUntil===undefined && (snapshot.sourceStatus!=='healthy' || !coverage.complete || coverage.missing.length ||
    !(Date.parse(coverage.from)<=reset+GAME_DAY_MS && Date.parse(coverage.until)>=reset+15*GAME_DAY_MS))) ||
    plan.dates.length!==15 || !Number.isInteger(horizon) || horizon<1 || horizon>14)
    throw new AdaptiveSourceUnavailable('adaptive_source_incomplete');
  const expected=certifiedCohortWeights(input.cohortWeights,snapshot.version);
  if(forecastIdentity.snapshotHash!==plan.sourceIdentity || forecastIdentity.snapshotRevision!==snapshot.revision ||
    forecastIdentity.sourceHash!==snapshot.sourceHash || plan.snapshotVersion!==snapshot.version ||
    plan.descriptor.laws!==snapshot.laws || expected.length!==n || priors.length!==n || expected.some((v,c)=>!eq(v,priors[c]!)))
    throw Error('adaptive_admission_mismatch');
  const received=new Set(input.receivedEventIds), receivedCount=received.size;
  // A future receipt suppresses the physical event in futureEvents; never accept it.
  if(conditionalUntil===undefined)for(const event of snapshot.events){check();const claim=isCertifiedEventClaimable(snapshot,event,input.asOf);
    if(claim!==received.delete(event.id))throw new AdaptiveSourceUnavailable('adaptive_receipt_mismatch');}
  if(received.size || receivedCount!==(input.receivedEventIds?.length??0))throw new AdaptiveSourceUnavailable('adaptive_receipt_mismatch');
  const epochs:{day:number;at:number}[]=[],refs:CertifiedLawRef[][]=[];
  const events=futureEvents(input);
  if(events.length!==plan.descriptor.events.length)throw Error('adaptive_admission_mismatch');
  for(const [i,event] of events.entries()){
    check();const day=eventOffset(input,event),at=Date.parse(event.at),bound=plan.descriptor.events[i]!;
    // Events are sorted by physical receipt instant. Later rows, even other
    // receipts in this game day beyond the elapsed-day cutoff, are not usable.
    if(day>horizon)break;
    if(day!==bound.day || event.refs!==bound.refs)throw Error('adaptive_admission_mismatch');
    if(!event.refs.some(r=>r.count))continue;
    if(at<=now || at>now+horizon*GAME_DAY_MS)throw Error('adaptive_epoch_outside_horizon');
    if(epochs.at(-1)?.at!==at){epochs.push({day,at});refs.push([]);}
    refs[refs.length-1]!.push(...event.refs.filter(r=>r.count));
  }
  const keys=refs.map(r=>JSON.stringify(r.map(({lawId,count})=>[lawId,count])));
  const denominator=priors.reduce(common,1n), initial=primitive(priors.map(p=>p.n*(denominator/p.d)));
  const kernels=new Map<string,{atoms:Atom[];scale:bigint}>(), branches=new Map<string,readonly Row[]>();
  let retained=0,physicalCacheBytes=0,closed=false;
  function own(bytes:number){if(bytes>MAX_RETAINED-retained)throw new AdaptiveSourceUnavailable('adaptive_source_memory_limit');
    retained+=bytes;budget.reserve(bytes);}
  function release(){if(closed)return;closed=true;kernels.clear();branches.clear();budget.release(retained);retained=0;}
  function kernel(day:number){const key=keys[day]!, old=kernels.get(key);if(old)return old;
    const map=new Map<string,Atom>();let scale=1n;
    try{budget.reserve(LAW_WORKSPACE);
      for(let c=0;c<n;c++){
        if(priors[c]!.n===0n)continue;
        let rows:readonly ExactSupplyOutcome[]|undefined;
        for(const ref of refs[day]!){const law=getCertifiedLawDistribution(ref,c as DispatchCohort,{laws:snapshot.laws,checkBudget:check});
          const cacheBytes=certifiedSupplyLawPayloadBytes();
          if(cacheBytes>physicalCacheBytes){own(cacheBytes-physicalCacheBytes);physicalCacheBytes=cacheBytes;}
          rows=rows?convolveCertifiedDistributions(rows,law,check):law;}
        let total=ZERO;
        for(const {pieces,mass} of rows??[{pieces:[0,0,0] as const,mass:ONE}]){
          check();if(!pieces.every(Number.isSafeInteger))throw new AdaptiveSourceUnavailable('adaptive_piece_limit');
          const k=pieces.join(',');let atom=map.get(k);
          if(!atom){own(256+32*n);atom={pieces,masses:Array<Q>(n).fill(ZERO)};map.set(k,atom);}
          atom.masses[c]=add(atom.masses[c]!,mass);total=add(total,mass);
          own(Math.ceil(bits(mass)/4));scale=common(scale,mass);
        }
        if(!eq(total,ONE))throw Error('adaptive_law_mass');
      }
    }finally{budget.release(LAW_WORKSPACE);}
    const k={atoms:[...map.values()],scale};kernels.set(key,k);return k;
  }
  // Epoch metadata, including the rational elapsed-time witnesses retained by the scorer.
  try{own(4096+epochs.length*384+keys.reduce((s,key)=>s+key.length*2,0)+refs.reduce((s,list)=>s+list.length*8,0));}
  catch(error){release();throw error;}
  return {initial,epochs,release,next(day:number,belief:string):readonly Row[]{
    check();if(closed||!Number.isInteger(day)||day<0||day>=epochs.length)throw Error('adaptive_epoch');
    if(belief.length>n*(MAX_BITS+1)||!/^\d+(,\d+)+$/.test(belief))throw Error('adaptive_belief');
    const prior=belief.split(',').map(BigInt);
    if(prior.length!==n || prior.some((v,c)=>v.toString(2).length>MAX_BITS || (v>0n && !priors[c]!.n)) || primitive(prior)!==belief)throw Error('adaptive_belief');
    const key=keys[day]+';'+belief,old=branches.get(key);if(old)return old;
    try{const {atoms,scale}=kernel(day),out:Row[]=[];
      own(128+2*key.length);
      for(const {pieces,masses} of atoms){check();const joint=masses.map((v,c)=>prior[c]!*v.n*(scale/v.d));
        const weight=joint.reduce((a,b)=>a+b,0n);if(weight===0n)continue;
        const posterior=primitive(joint);own(192+2*posterior.length+Math.ceil(weight.toString(2).length/8));
        out.push({pieces,weight,belief:posterior});
      }
      check();branches.set(key,out);return out;
    }catch(error){release();throw error;}
  }};
}
