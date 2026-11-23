import { add, cmp, fromBinary64, fromWire, mul, q, type Q } from '../../shared/certifiedRational.ts';
import { CertifiedLimit, evidenceBudgetView, reserveTargetPayload } from '../certified/budget.ts';
import { payloadBytes } from '../certifiedRuntime/protocol.ts';
import type { Triple } from '../certified/types.ts';
import { up, down, rationalBound } from './numeric.ts';
import { assessAccuracy } from './selection.ts';
import { withEndpointBatch, solveEndpointEvidence } from './fusedEndpoint.ts';
import { deriveJointSourceCertificate } from './sourcePlan.ts';
import { isJointSourceLimitReason } from './source.ts';
import { batchDecision } from './batchDecision.ts';
import { positiveSupportCover } from './supportProof.ts';
import type { ApproxComputation, ApproxDate, ApproxDiagnostics, ApproxRisk, ApproxRunContext, ApproxValue, Bound, BoundTriple, EndpointResult, JointSource, JointDatePlan } from './types.ts';

const COLOURS=[0,1,2] as const;

function enclosed(estimate:number,lower:number,upper:number,min=0,max=Infinity):Bound {
  if(!Number.isFinite(estimate)||!Number.isFinite(lower)||!Number.isFinite(upper)||lower>upper)
    throw new Error('approx_invalid_numeric_enclosure');
  const lo=Math.max(min,lower),hi=Math.min(max,upper);
  if(lo>hi)throw new Error('approx_empty_numeric_enclosure');
  return {estimate:Math.max(lo,Math.min(hi,estimate)),lower:lo,upper:hi};
}

export function complementBound(value:Bound):Bound {
  return enclosed(1-value.estimate,Math.max(0,down(1-value.upper)),Math.min(1,up(1-value.lower)),0,1);
}


export function makeApproxValue(p:Bound,consumed:BoundTriple,prices:[Q,Q,Q],total?:Bound,burden?:Bound):ApproxValue {
  let cEstimate=0,cLower=0,cUpper=0,bEstimate=0,bLower=0,bUpper=0;
  for(const k of COLOURS){
    const price=rationalBound(prices[k]),colour=consumed[k];
    cEstimate+=colour.estimate;cLower=down(cLower+colour.lower);cUpper=up(cUpper+colour.upper);
    bEstimate+=price.estimate*colour.estimate;
    bLower=down(bLower+down(price.lower*colour.lower));bUpper=up(bUpper+up(price.upper*colour.upper));
  }
  // Intersect independent certificates, but never discard the actual algebraic
  // centre: its tiny rounding difference is included in the enclosing hull.
  const cLo=total?Math.max(cLower,total.lower):cLower,cHi=total?Math.min(cUpper,total.upper):cUpper;
  const bLo=burden?Math.max(bLower,burden.lower):bLower,bHi=burden?Math.min(bUpper,burden.upper):bUpper;
  if(cLo>cHi||bLo>bHi)throw new Error('approx_inconsistent_consumption_certificates');
  const c=enclosed(cEstimate,Math.min(cLo,cEstimate),Math.max(cHi,cEstimate));
  const b=enclosed(bEstimate,Math.min(bLo,bEstimate),Math.max(bHi,bEstimate));
  return {p,b,c,consumed};
}

export function currentDate(ctx:Pick<ApproxRunContext,'current'|'p0'|'prices'>,prefixKey='current'):ApproxDate {
  const value=ctx.current.value;
  const consumed=value.expectedConsumed.map(wire=>rationalBound(fromWire(wire))) as BoundTriple;
  const p=rationalBound(ctx.p0);
  const objective=makeApproxValue(p,consumed,ctx.prices,rationalBound(fromWire(value.expectedTotalConsumptionC)),rationalBound(fromWire(value.weightedExpectedConsumptionB)));
  const certified=ctx.p0.n*400n>=397n*ctx.p0.d?1:0;
  const risk:ApproxRisk={meanSuccessP:p,insufficientGainMass:{estimate:1,lower:1,upper:1},noFurtherWaitCertifiedMass:{estimate:certified,lower:certified,upper:certified},renewedWaitUpperBound:{estimate:1-certified,lower:1-certified,upper:1-certified}};
  return {day:0,value:objective,risk,prefixKey,equalityKey:null,exactObjective:{p:value.successP,b:value.weightedExpectedConsumptionB,c:value.expectedTotalConsumptionC}};
}


/** Separate from the source's FULL-L1 certificate; never shrink from reported skips. */
export const ENDPOINT_PRUNE_BUDGET = 1e-6;
const DATE_BYTES = 65_536;
// Includes final-certificate construction headroom, released before finalization.
const STREAM_BYTES = 8192 + 65_536;

export function finalizeComputation(ctx:Pick<ApproxRunContext,'input'|'prices'|'plan'|'budget'>, records:ApproxDate[], diagnostics:ApproxDiagnostics, reason:string|null=null):ApproxComputation {
  ctx.budget.check();
  const accuracy=assessAccuracy(records,ctx.prices,'deterministic-bound',null);
  const failure=reason??(records.length!==15?'all_dates_not_completed':!accuracy.practical?'accuracy_not_met':null);
  const decision=failure?{status:'unavailable' as const,day:null}:batchDecision(records);
  return {records,accuracy,decision,diagnostics:{...diagnostics,...ctx.plan.hostWork,hostPerformedWork:ctx.plan.hostPerformedWork,hostComplexMacWork:Math.ceil(ctx.plan.hostPerformedWork/8),sourceWorkUnit:'complex_mac_200m'},reason:failure,
    certificate:{kind:'deterministic',sourceL1UpperByDay:records.map(record=>ctx.plan.dates[record.day]!.sourceL1Upper),endpointPruningBudget:ENDPOINT_PRUNE_BUDGET,endpointRelativeBound:2e-13},
    sourceCertificate:deriveJointSourceCertificate(ctx.plan,records.length-1,evidenceBudgetView(ctx.budget))};
}

/** Bounded prior-mixture accumulator. Priors are already applied by the source.
 * No date table, renormalization, independent-colour marginal or stock re-addition. */
export function aggregateJointSource(ctx:ApproxRunContext,source:JointSource,records:ApproxDate[]):ApproxComputation {
  reserveTargetPayload(ctx.budget,STREAM_BYTES);
  let date:JointDatePlan|undefined,expectedRows=0,seenRows=0,mixtureOpen=false,mixtureComplete=false,initialized=false,done=false;
  let means=new Float64Array(8),lower=new Float64Array(8),upper=new Float64Array(8);
  let sums=new Float64Array(8),lo=new Float64Array(8),hi=new Float64Array(8);
  let mass=0,datePrunedMass=0,prunedRows=0,prunedMass=0,reason:string|null=null;
  let lowerCorner:EndpointResult|undefined;
  let upperCorner:EndpointResult|undefined,strictBurdenProof:ApproxDate['strictBurdenProof'];
  const kit=ctx.current.status==='use_certified'?ctx.current.kit:null;
  const axis=['blue','purple','yellow'].indexOf(kit??'');
  let reservedDate=false;
  try {
    while(!done) {
      ctx.budget.checkNumerical();
      const read=source.read(event=>{
        ctx.budget.checkNumerical();
        if(event.kind==='init') { if(initialized||event.streamKind!=='prior-mixture')throw new Error('service_h14_source_init'); initialized=true; return; }
        if(event.kind==='error') {
          if(event.lastAckedDay!==records.length-1)throw new Error('service_h14_source_ack_binding');
          if(!isJointSourceLimitReason(event.reason))throw new Error(event.reason);
          throw new CertifiedLimit(event.reason);
        }
        if(!initialized)throw new Error('service_h14_source_before_init');
        if(event.kind==='done') { if(date||records.length!==15)throw new Error('service_h14_source_early_done'); done=true;return; }
        if(event.kind==='date_begin') {
          if(date||event.day!==records.length||event.day>14)throw new Error('service_h14_date_sequence');
          reserveTargetPayload(ctx.budget,DATE_BYTES);reservedDate=true;
          date=ctx.plan.dates[event.day];if(!date)throw new Error('service_h14_source_plan_day');
          // Full physical support, independent of approximate mixture masses.
          lowerCorner=date.minUnits.every((n,k)=>n===date!.maxUnits[k])?undefined:ctx.endpoints.solve(date.minUnits);
          // The pending-date reservation owns the retained decoded corner;
          // native output views never cross endpoint calls.
          if(lowerCorner&&payloadBytes(lowerCorner)>DATE_BYTES/2)throw new CertifiedLimit('response_payload_ceiling');
          let cover:NonNullable<ApproxDate['strictBurdenProof']>['lower']['cover'];
          if(lowerCorner&&lowerCorner.p.lower<1){
            const frontier=positiveSupportCover(ctx.plan,date.day,()=>ctx.budget.checkNumerical());
            if(frontier){
              const candidates:{units:Triple;p:EndpointResult['p']}[]=[];
              for(const units of frontier){
                const p=ctx.endpoints.solve(units).p;
                // One unproved point already prevents this optional certificate.
                if(p.lower!==1)break;
                candidates.push({units,p});
              }
              if(candidates.length===frontier.length)cover=candidates;
            }
          }
          const certainSuccess=lowerCorner?.p.lower===1||cover!==undefined;
          upperCorner=certainSuccess?solveEndpointEvidence(ctx.endpoints,date.maxUnits):undefined;
          strictBurdenProof=undefined;
          if(upperCorner?.exactObjective&&certainSuccess&&
            (cover||!lowerCorner!.exactObjective||cmp(fromWire(lowerCorner!.exactObjective.b),fromWire(upperCorner.exactObjective.b))>0)){
            // A marginal minimum is attained by positive full-support mass.
            // On that face all other coordinates are bounded by global maxima.
            // This does not assume that an arbitrary in-box joint atom exists.
            faces:for(let c=0;c<ctx.plan.cohortCount;c++){
              if(ctx.priors[c]!.n===0n)continue;
              for(const coordinate of COLOURS){
                const minimum=date.cohorts[c]!.minUnits[coordinate];
                if(minimum===date.maxUnits[coordinate])continue;
                const units:[number,number,number]=[date.maxUnits[0],date.maxUnits[1],date.maxUnits[2]];units[coordinate]=minimum;
                let face=ctx.endpoints.solve(units);
                let burdenLower=q(0);
                for(const k of COLOURS)burdenLower=add(burdenLower,mul(ctx.prices[k],fromBinary64(face.consumed[k].lower)));
                const baseline=fromWire(upperCorner.exactObjective.b);
                const separated=cmp(burdenLower,baseline)>0;
                if(!separated&&!face.exactObjective)face=solveEndpointEvidence(ctx.endpoints,units);
                if(separated||(face.exactObjective&&cmp(fromWire(face.exactObjective.b),baseline)>0)){
                  strictBurdenProof={
                    lower:{units:date.minUnits,p:lowerCorner!.p,...(cover?{cover}:{})},
                    upper:{units:date.maxUnits,objective:upperCorner.exactObjective},
                    witness:{cohort:c,coordinate,units,consumed:face.consumed,...(!separated&&face.exactObjective?{exactObjective:face.exactObjective}:{})},
                  };
                  break faces;
                }
              }
            }
          }
          means.fill(0);lower.fill(0);upper.fill(0);mixtureComplete=false;return;
        }
        if(!date||event.day!==date.day)throw new Error('service_h14_date_binding');
        if(event.kind==='mixture_begin') {
          if(mixtureOpen||mixtureComplete)throw new Error('service_h14_mixture_sequence');
          mixtureOpen=true;expectedRows=event.rowCount;seenRows=0;mass=0;
          if(!Number.isSafeInteger(expectedRows)||expectedRows<0||expectedRows>1_000_000)throw new Error('service_h14_row_count');
          datePrunedMass=0;sums.fill(0);lo.fill(0);hi.fill(0);return;
        }
        if(event.kind==='rows') {
          if(!mixtureOpen||event.rows.length<1||event.rows.length>32)throw new Error('service_h14_chunk_sequence');
          const units:Triple[]=[],masses:number[]=[];
          const envelope=date;
          for(const row of event.rows) {
            if(++seenRows>expectedRows||!Number.isFinite(row.mass)||row.mass<=0||row.mass>1||row.units.some((n,k)=>!Number.isSafeInteger(n)||n<envelope.minUnits[k]!||n>envelope.maxUnits[k]!))throw new Error('service_h14_source_row');
            mass+=row.mass;
            // Validate and count original mass even when its endpoint is omitted.
            // Ascending source order improves coverage, but is not a soundness condition.
            const nextPrunedMass=up(datePrunedMass+row.mass);
            if(nextPrunedMass<=ENDPOINT_PRUNE_BUDGET){
              datePrunedMass=nextPrunedMass;
              prunedRows++;prunedMass=up(prunedMass+row.mass);
              continue;
            }
            units.push(row.units);masses.push(row.mass);
          }
          if(units.length)withEndpointBatch(ctx.endpoints,units,endpoints=>{
            const threshold=add(ctx.p0,q(date!.day+2,400)),tb=rationalBound(threshold),certain=q(397,400),cb=rationalBound(certain);
            const regrets=kit?ctx.endpoints.batchRegrets(units,date!.day,axis,ctx.current.uses,date!.thresholdTicks):null;
            for(let i=0;i<endpoints.length;i++) {
              const endpoint=endpoints[i]!,weight=masses[i]!,root=units[i]!;
              const insufficient=endpoint.p.upper<=tb.lower?1:endpoint.p.lower>tb.upper?0:ctx.endpoints.compareProbability(root,threshold)<=0?1:0;
              const certified=endpoint.p.lower>=cb.upper?1:endpoint.p.upper<cb.lower?0:ctx.endpoints.compareProbability(root,certain)>=0?1:0;
              const values=[endpoint.p,...endpoint.consumed,{estimate:insufficient,lower:insufficient,upper:insufficient},{estimate:certified,lower:certified,upper:certified}];
              if(regrets){
                const r=regrets[i]!, mass=r.above===null?0.5:r.above?1:0;
                values.push({lower:r.lower,upper:r.upper,estimate:(r.lower+r.upper)/2},{lower:r.above===true?1:0,upper:r.above===false?0:1,estimate:mass});
              }
              for(let k=0;k<values.length;k++){const v=values[k]!;sums[k]=sums[k]!+weight*v.estimate;lo[k]=down(lo[k]!+down(weight*v.lower));hi[k]=up(hi[k]!+up(weight*v.upper));}
            }
          });
          return;
        }
        if(event.kind==='mixture_end') {
          if(!mixtureOpen||seenRows!==expectedRows)throw new Error('service_h14_mixture_end');
          const nu=up((8*expectedRows+64)*2**-53),gamma=up(nu/down(1-nu));
          const l1=date.sourceL1Upper;
          if(!Number.isFinite(gamma)||gamma<0||mass>up(1+gamma)||Math.abs(mass-1)>up(l1+gamma))throw new Error('service_h14_source_mass');
          const ranges=[1,...date.maxUnits.map(n=>10*n),1,1,1,1];
          const error=up(up(l1+ENDPOINT_PRUNE_BUDGET)+gamma);
          for(let k=0;k<ranges.length;k++){
            const slack=up(error*ranges[k]!);
            const cl=Math.max(0,down(lo[k]!-slack)),cu=Math.min(ranges[k]!,up(hi[k]!+slack));
            means[k]=sums[k]!;lower[k]=cl;upper[k]=cu;
          }
          mixtureOpen=false;mixtureComplete=true;return;
        }
        if(event.kind!=='date_end'||mixtureOpen||!mixtureComplete)throw new Error('service_h14_date_end');
        const p=enclosed(means[0]!,lower[0]!,upper[0]!,0,1);
        const colours=COLOURS.map(k=>enclosed(means[k+1]!,lower[k+1]!,upper[k+1]!,0,10*date!.maxUnits[k])) as BoundTriple;
        let value=makeApproxValue(p,colours,ctx.prices),insufficient=enclosed(means[4]!,lower[4]!,upper[4]!,0,1),certified=enclosed(means[5]!,lower[5]!,upper[5]!,0,1);
        let equalityKey:string|null=null,exactObjective:ApproxDate['exactObjective'];
        // FULL exact positive support, including Q63-underflowed atoms, must collapse.
        if(date.minUnits.every((n,k)=>n===date!.maxUnits[k])){
          const root=solveEndpointEvidence(ctx.endpoints,date.minUnits);
          if(!root.exactObjective)throw new Error('service_h14_root_evidence_required');
          value=makeApproxValue(root.p,root.consumed,ctx.prices,rationalBound(fromWire(root.exactObjective.c)),rationalBound(fromWire(root.exactObjective.b)));
          exactObjective=root.exactObjective;equalityKey='point:'+ctx.sid+':'+date.minUnits.join(',');
          const low=ctx.endpoints.compareProbability(date.minUnits,add(ctx.p0,q(date.day+2,400)))<=0?1:0;
          const high=ctx.endpoints.compareProbability(date.minUnits,q(397,400))>=0?1:0;
          insufficient={estimate:low,lower:low,upper:low};certified={estimate:high,lower:high,upper:high};
        }
        let objectiveProof:ApproxDate['objectiveProof'];
        if(!exactObjective){
          // Optional native evidence only: never force a new exact solve for general R0.
          const least=lowerCorner;
          if(!least)throw new Error('service_h14_missing_lower_corner');
          if(least.p.lower===1&&least.p.upper===1&&least.exactObjective){
            const greatest=upperCorner!;
            if(greatest.exactObjective&&(['p','b','c'] as const).every(key=>cmp(fromWire(least.exactObjective![key]),fromWire(greatest.exactObjective![key]))===0)){
              exactObjective=least.exactObjective;
              objectiveProof={kind:'full-support-corners',lower:{units:date.minUnits,objective:least.exactObjective},upper:{units:date.maxUnits,objective:greatest.exactObjective}};
              // Colour consumption is NOT monotone. Keep the streamed colour vector.
            }
          }
        }
        const positiveZeroKitWitness=date.positiveZeroKitCohort==null?undefined:{cohort:date.positiveZeroKitCohort};
        const record:ApproxDate={day:date.day,value,risk:{meanSuccessP:value.p,insufficientGainMass:insufficient,noFurtherWaitCertifiedMass:certified,renewedWaitUpperBound:complementBound(certified)},prefixKey:date.prefixKey,equalityKey,...(exactObjective?{exactObjective}:{}),...(objectiveProof?{objectiveProof}:{}),...(strictBurdenProof?{strictBurdenProof}:{}),...(positiveZeroKitWitness?{positiveZeroKitWitness}:{})};
        if(kit) record.batchEvidence={thresholdTicks:date.thresholdTicks,day:date.day,prefixKey:date.prefixKey,kit,uses:ctx.current.uses,mean:enclosed(means[6]!,lower[6]!,upper[6]!,0,1),mass:enclosed(means[7]!,lower[7]!,upper[7]!,0,1)};
        if(payloadBytes(record)>DATE_BYTES/2)throw new CertifiedLimit('response_payload_ceiling');
        // All cohort/endpoint/risk/allocation work is complete BEFORE the native commit.
        ctx.budget.checkNumerical();
        // Allocate the private pending slot before ack; rollback on rejection.
        // The narrow ack boundary has no fallible post-success checks.
        records.push(record);
        try{source.ackDate(date.day);}catch(error){records.pop();throw error;}
        reservedDate=false;date=undefined;
      });
      if(read==='done'&&!done)throw new Error('service_h14_source_missing_done');
    }
  }catch(error){
    if(!(error instanceof CertifiedLimit))throw error;
    reason=error.reason;
  }finally{if(reservedDate)ctx.budget.release(DATE_BYTES);ctx.budget.release(STREAM_BYTES);}
  ctx.budget.beginFinalization();
  return finalizeComputation(ctx,records,{sourcePrunedRows:prunedRows,sourcePrunedMassUpperSum:prunedMass,endpointPruningBudget:ENDPOINT_PRUNE_BUDGET},reason);
}
