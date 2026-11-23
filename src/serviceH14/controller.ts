import { adaptiveDecision } from './adaptiveDecision.ts';
import { fromWire, type Q } from '../../shared/certifiedRational.ts';
import { isCertifiedEventClaimable } from '../../shared/certifiedSupply.ts';
import { CertifiedLimit, reserveTargetPayload } from '../certified/budget.ts';
import { encode } from '../certified/game.ts';
import { WasmKernel } from '../certified/wasmBackend.ts';
import { payloadBytes } from '../certifiedRuntime/protocol.ts';
import { aggregateJointSource, currentDate, finalizeComputation } from './aggregate.ts';
import type { ServiceH14Admission } from './admission.ts';
import { createFusedEndpointSolver, CurrentBatchContractError } from './fusedEndpoint.ts';
import { loadServiceH14Module } from './loader.ts';
import { SERVICE_H14_PROFILE } from './profile.ts';
import { openJointSource } from './source.ts';
import type { ServiceH14WorkBudget } from './workBudget.ts';
import type { ApproxDate, ApproxRunContext, EndpointSolver, JointSource, ServiceH14Output, ServiceH14Request } from './types.ts';

// Only verified machine code is reusable; every Engine/source/endpoint belongs to one request.
let modulePromise:Promise<WebAssembly.Module>|undefined;

export async function runServiceH14Request(request:ServiceH14Request,admission:ServiceH14Admission,budget:ServiceH14WorkBudget,onCurrent?:(output:ServiceH14Output)=>void,readWasmBytes?:()=>Promise<Uint8Array>):Promise<ServiceH14Output>{
  const started=performance.now();
  const output:ServiceH14Output={schemaVersion:1,numericalContract:'bounded-error-h14-v1',profile:SERVICE_H14_PROFILE,
    inputSha256:admission.inputSha256,forecastIdentity:admission.forecastIdentity,request:{id:request.id,generation:request.generation,sessionId:request.sessionId},
    current:null,pricingWeights:null,records:[],accuracy:{kind:'deterministic-bound',confidence:null,practical:false,strict:false,maxProbabilityWidth:0,maxPieceWidth:0,maxRiskWidth:0},
    decision:{status:'unavailable',day:null},diagnostics:{},reason:'calculation_in_progress',status:'incomplete',elapsedMs:0};
  let kernel:WasmKernel|undefined,endpoints:EndpointSolver|undefined,source:JointSource|undefined;
  let prices:[Q,Q,Q]|undefined;
  let interruptedReason:string|undefined;
  const records:ApproxDate[]=[];
  const received=new Set(request.input.receivedEventIds??[]);
  const claim=admission.conditionalUntil===undefined&&request.input.snapshot.events.some(event=>isCertifiedEventClaimable(request.input.snapshot,event,request.input.asOf)&&!received.has(event.id));
  const unhealthy=request.input.snapshot.sourceStatus!=='healthy'||request.input.snapshot.warnings.length>0;
  const gate=claim?'current_claimable_unreceived':admission.legacyLeaseUntil!==undefined?'legacy_current_only':unhealthy&&admission.conditionalUntil===undefined?'forecast_source_withheld':null;
  const refresh=(reason:string|null)=>{
    if(prices&&records.length)Object.assign(output,finalizeComputation({input:request.input,prices,plan:admission.plan,budget},records,output.diagnostics,reason));
  };
  try{
    // Retained input/plan plus copied response capacity coexist with the shared native heap.
    reserveTargetPayload(budget,payloadBytes(request)+admission.retainedBytes+6*1024*1024);
    budget.checkNumerical();
    if(!modulePromise)modulePromise=loadServiceH14Module(readWasmBytes,budget).catch(error=>{modulePromise=undefined;throw error;});
    const module=await modulePromise;budget.checkNumerical();
    kernel=new WasmKernel(module,budget);
    const sid=encode(request.input.grade,request.input.level,request.input.exp);
    const pricing=kernel.prepare(request.input,sid,admission.priors);
    prices=pricing.weights.map(fromWire) as [Q,Q,Q];output.pricingWeights=[...pricing.weights];
    kernel.initialize(prices);
    reserveTargetPayload(budget,65_536);
    output.current=kernel.current(sid,request.input);
    records.push(currentDate({current:output.current,p0:fromWire(output.current.value.successP),prices},admission.plan.dates[0]!.prefixKey));
    refresh(gate??'calculation_in_progress');
    if(gate){output.status=claim?'claim_required':'withheld';}
    else{
      if(request.input.computeMinimumWait!==false){
        output.current=kernel.minimumWait(sid,request.input,output.current).current;
        records[0]=currentDate({current:output.current,p0:fromWire(output.current.value.successP),prices},admission.plan.dates[0]!.prefixKey);
        refresh('calculation_in_progress');
      }
      if(onCurrent){output.elapsedMs=performance.now()-started;onCurrent(structuredClone(output));}
      const stop=request.input.computeWaiting===false?'waiting_not_requested':admission.conditionalUntil===undefined&&!request.input.snapshot.coverage.future.complete?'future_coverage_incomplete':null;
      if(stop)refresh(stop);
      else{
        endpoints=createFusedEndpointSolver(kernel,sid,admission.plan.maxUnits);
        // Current and minimumWait must finish before joint_source consumes SUPPLY.
        source=openJointSource(kernel,admission.plan);
        const ctx:ApproxRunContext={input:request.input,sid,prices,priors:[...admission.priors],current:output.current,p0:fromWire(output.current.value.successP),budget,endpoints,plan:admission.plan};
        Object.assign(output,aggregateJointSource(ctx,source,records));
        output.status=output.records.length===15&&output.accuracy.practical&&output.reason===null?'complete':'incomplete';
        if(output.status==='complete'){
          const portable=request.portableTollReady===true&&!!admission.portableToll;
          const adaptive=adaptiveDecision(request.input,admission,output,budget,portable);
          if(portable&&adaptive)output.diagnostics['portableToll']=true;
          if(adaptive)output.adaptive=adaptive;
        }
      }
    }
    budget.beginFinalization();
  }catch(error){
    delete output.adaptive;
    if(error instanceof CurrentBatchContractError)throw error;
    budget.beginFinalization();
    const reason=error instanceof CertifiedLimit?error.reason:error instanceof Error?error.message:String(error);
    output.status=error instanceof CertifiedLimit?(!output.current?'incomplete':gate?(claim?'claim_required':'withheld'):'incomplete'):'error';
    interruptedReason=reason;output.reason=reason;output.decision={status:'unavailable',day:null};
  }finally{
    try{
      output.elapsedMs=performance.now()-started;
      output.diagnostics={...output.diagnostics,...endpoints?.diagnostics(),managedPayloadPeakBytes:budget.managedPayloadPeakBytes,
        managedPayloadBytes:budget.managedPayloadBytes,exactMemoEntries:budget.memoEntries,exactTransitions:budget.exactTransitions,
        wasmLinearBytes:kernel?.memoryBytes??0,physicalAggregateRam:'UNKNOWN',numericalPayloadCeiling:budget.maxManagedPayloadBytes};
    }finally{
      // No child owner can consume the other's Engine. Even cleanup failure cannot skip final ownership release.
      try{source?.dispose();}finally{try{endpoints?.dispose();}finally{try{kernel?.finishSourceRequest();}finally{kernel?.dispose();}}}
    }
  }
  // A failed numerical/finalization allocation may still have ACKed rows.
  // Retire its native owners before reconstructing their host certificate.
  if(interruptedReason!==undefined)refresh(interruptedReason);
  return output;
}
