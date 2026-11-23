import { assertPriceChild, auditedPriceParent, prefixSeal, priceSeal, type PriceParent } from './priceChain.ts';
import { assertCertifiedForecastIdentity, sameCertifiedForecastIdentity } from '../../shared/certifiedForecastIdentity.ts';
import { payloadBytes, CERTIFIED_RESPONSE_PAYLOAD_CEILING, CERTIFIED_RESPONSE_METADATA_CEILING, CERTIFIED_RUNTIME_PAYLOAD_CEILING } from '../certifiedRuntime/protocol.ts';
import { admitServiceH14Input, scanServiceJson, INPUT_SCAN_BYTES, type ServiceH14Admission } from './admission.ts';
import { CertifiedLimit } from '../certified/budget.ts';
import { assertServiceH14Output, ServiceH14AuditBudgetError } from './binding.ts';
import { isCertifiedPrefixStop } from './source.ts';
import { adaptivePrefixDecision } from './adaptiveDecision.ts';
import { CurrentBatchContractError } from './fusedEndpoint.ts';
import { runServiceH14Request } from './controller.ts';
import { ServiceH14DeadlineError, serviceH14DeadlineMs } from './deadline.ts';
import { SERVICE_H14_PROFILE, assertServiceH14Profile } from './profile.ts';
import { ServiceH14WorkBudget } from './workBudget.ts';
import type { ServiceH14Profile, ServiceH14Request, ServiceH14Output, ServiceH14WorkerMessage } from './types.ts';
import { PreviewSourceError } from '../lib/previewSourceError.ts';

export type ServiceH14RuntimeRequest=ServiceH14Request|{type:'init';generation:number;profile:ServiceH14Profile;priceParent?:PriceParent;priceKey?:string};
type Context=Pick<ServiceH14Request,'id'|'generation'|'sessionId'|'inputSha256'|'forecastIdentity'|'profile'>;
export type ServiceH14RuntimeMessage=ServiceH14WorkerMessage
  |{type:'initComplete';generation:number;profile:ServiceH14Profile}
  |{type:'initError';generation:number;profile:ServiceH14Profile;message:string}
  |({type:'computeStarted'}&Context)
  |({type:'error';code:'protocol'|'deadline'|'memory'|'solver';message:string}&Context);
function context(request:ServiceH14Request):Context{
  const {id,generation,sessionId,inputSha256,forecastIdentity,profile}=request;
  return {id,generation,sessionId,inputSha256,forecastIdentity,profile};
}

class BindingCapacityError extends Error {}

/** Real numerical controller only: no numerical-response injection or alternate solver path. */
export function createServiceH14WorkerHandler(post:(message:ServiceH14RuntimeMessage)=>void,readWasmBytes?:()=>Promise<Uint8Array>){
  let priceKey:string|undefined;
  let priceParent:PriceParent|undefined;
  let generation:number|undefined,busy=false,closed=false,lastId=0;
  async function handle(request:ServiceH14RuntimeRequest):Promise<void>{
    if(closed)return;
    let owns=false,code:'protocol'|'deadline'|'memory'|'solver'='protocol';
    let ownedAdmission: ServiceH14Admission | undefined;
    try{
      // Fixed scan reservation precedes untrusted key traversal and payload serialization.
      let admissionBytes=INPUT_SCAN_BYTES;
      scanServiceJson(request,()=>{if(closed)throw new Error('service_h14_worker_closed');});
      const keys=request.type==='init'?['type','generation','profile',...(request.priceKey ? ['priceKey'] : []),...(request.priceParent ? ['priceParent'] : [])]:['type','id','generation','sessionId','input','inputSha256','forecastIdentity','profile','deadlineAt'];
      if(request.type==='calculate'&&request.portableTollReady===true)keys.push('portableTollReady');
      if(Object.keys(request).length!==keys.length||keys.some(key=>!Object.hasOwn(request,key)))throw new Error('service_h14_request_keys');
      assertServiceH14Profile(request.profile);
      if(!Number.isSafeInteger(request.generation)||request.generation<1)throw new Error('service_h14_generation');
      if(request.type==='init'){
        if(generation!==undefined||busy)throw new Error('service_h14_already_initialized');
        if(request.priceKey!==undefined && (typeof request.priceKey!=='string'||!/^[-a-f0-9]{36}$/.test(request.priceKey)))throw Error('service_h14_price_key');
        priceKey=request.priceKey;priceParent=request.priceParent;generation=request.generation;post({type:'initComplete',generation,profile:SERVICE_H14_PROFILE});return;
      }
      if(request.type!=='calculate'||request.generation!==generation||busy||!Number.isSafeInteger(request.id)||request.id<=lastId||typeof request.sessionId!=='string'||request.sessionId.length<1||request.sessionId.length>256||!/^[a-f0-9]{64}$/.test(request.inputSha256))throw new Error('service_h14_request_protocol');
      const began=performance.now(),remaining=request.deadlineAt-Date.now();
      if(!Number.isFinite(remaining)||remaining<=0||remaining>serviceH14DeadlineMs(request.input)){code='deadline';throw new Error('service_h14_original_deadline');}
      // Map the wall clock ONCE. All preparation uses this numerical deadline too.
      const finalDeadlineAt=began+remaining,numericalDeadlineAt=finalDeadlineAt-300;
      const check=()=>{if(closed)throw new Error('service_h14_worker_closed');if(Date.now()>=request.deadlineAt||performance.now()>=finalDeadlineAt){code='deadline';throw new Error('service_h14_total_deadline');}};
      const checkNumerical=()=>{check();if(performance.now()>=numericalDeadlineAt){code='deadline';throw new Error('service_h14_numerical_deadline');}};
      busy=true;owns=true;lastId=request.id;
      const requestBytes=payloadBytes(request);
      const admitted=await admitServiceH14Input(request.input,bytes=>{
        admissionBytes=bytes;
        if(!Number.isSafeInteger(bytes)||bytes<0||requestBytes+admissionBytes>CERTIFIED_RUNTIME_PAYLOAD_CEILING){code='memory';throw new Error('service_h14_admission_capacity');}
      },checkNumerical);
      ownedAdmission=admitted;
      checkNumerical();
      if(admitted.inputSha256!==request.inputSha256||!sameCertifiedForecastIdentity(admitted.forecastIdentity,assertCertifiedForecastIdentity(request.forecastIdentity)))throw new Error('service_h14_request_binding');
      assertPriceChild(request.input,request,priceParent,priceParent && priceKey ? await priceSeal(priceKey,priceParent) : undefined);
      checkNumerical();
      priceParent=undefined;
      const budget=new ServiceH14WorkBudget(request.input,{deadlineAt:numericalDeadlineAt,finalDeadlineAt},began);
      post({type:'computeStarted',...context(request)});
      let currentSent=false,publishingFailure:unknown;
      let workspace=0,responseBytes=0,retainedCurrentBytes=0;
      const bindingBudget={check,reserve(bytes:number){
        workspace+=bytes;budget.reserve(bytes);
        if(!Number.isSafeInteger(bytes)||bytes<0||requestBytes+admissionBytes+workspace+retainedCurrentBytes+2*responseBytes>CERTIFIED_RUNTIME_PAYLOAD_CEILING){code='memory';throw new BindingCapacityError('service_h14_binding_capacity');}
      },release(bytes:number){workspace-=bytes;budget.release(bytes);}};
      const audit=(output:ServiceH14Output,mode:'current'|'final')=>{
        code='protocol';check();
        responseBytes=payloadBytes(output);
        if(responseBytes>CERTIFIED_RESPONSE_PAYLOAD_CEILING){code='memory';throw new Error('service_h14_response_ceiling');}
        assertServiceH14Output(output,request,admitted,mode,bindingBudget);check();
      };
      const publish=(output:ServiceH14Output,mode:'current'|'final',seal?:string,prefixProof?:string)=>{
        code='protocol';check();
        const message:ServiceH14WorkerMessage={type:mode==='current'?'current':'result',id:request.id,generation:request.generation,sessionId:request.sessionId,output,...(seal?{priceSeal:seal}:{}),...(prefixProof?{prefixSeal:prefixProof}:{})};
        if(payloadBytes(message)-responseBytes>CERTIFIED_RESPONSE_METADATA_CEILING)throw new Error('service_h14_response_metadata');
        post(message);
        if(mode==='current'){currentSent=true;retainedCurrentBytes=responseBytes;}
        responseBytes=0;code='solver';
      };
      code='solver';
      const output=await runServiceH14Request(request,admitted,budget,value=>{
        try{
          if(currentSent)throw new Error('service_h14_duplicate_current');
          audit(value,'current');publish(value,'current');
        }catch(error){publishingFailure=error;throw error;}
      },readWasmBytes);
      if(publishingFailure)throw publishingFailure;
      audit(output,'final');
      const prefix=output.status==='incomplete'&&isCertifiedPrefixStop(output.reason);
      const currentAuthority=currentSent && request.input.computeWaiting!==false &&
        (admitted.conditionalUntil!==undefined || request.input.snapshot.coverage.future.complete);
      // Score the validated ACK rows once, after releasing the native source
      // and DP. Keep the original 300ms publication reserve. Missing evidence
      // is safe; input, arithmetic and protocol faults are not.
      if(priceKey&&prefix&&currentAuthority&&performance.now()<numericalDeadlineAt){
        try{
          const result=adaptivePrefixDecision(request.input,admitted,output,{...bindingBudget,check(){
            check();if(performance.now()>=numericalDeadlineAt)throw new CertifiedLimit('request_budget_exhausted');
          }});
          if(result){
            output.prefixDecision=result;
            const size=payloadBytes(output);
            const sealWorkspace=6*size+1024;
            if(size>CERTIFIED_RESPONSE_PAYLOAD_CEILING||!budget.canReserve(sealWorkspace)||
              requestBytes+admissionBytes+retainedCurrentBytes+2*size+sealWorkspace>CERTIFIED_RUNTIME_PAYLOAD_CEILING)delete output.prefixDecision;
            else responseBytes=size;
          }
        }catch(error){
          if(!(error instanceof BindingCapacityError)&&!(error instanceof CertifiedLimit&&
            (error.reason==='managed_payload_ceiling'||error.reason==='request_budget_exhausted')))throw error;
          code='protocol';check();
        }
      }
      const parent=priceKey && auditedPriceParent(request.input,output,prefix&&currentAuthority);
      let proof:string|undefined;
      if(priceKey&&prefix&&output.records.length){
        const bytes=6*payloadBytes(output)+1024;
        bindingBudget.reserve(bytes);
        try{proof=await prefixSeal(priceKey,output);}finally{bindingBudget.release(bytes);}
      }
      publish(output,'final',parent && priceKey ? await priceSeal(priceKey,parent) : undefined,proof);
    }catch(error){
      // Binding's independent original-deadline check is a deadline, not a protocol fault.
      if(error instanceof ServiceH14DeadlineError || (error instanceof CertifiedLimit && error.reason==='request_budget_exhausted'))code='deadline';
      if(error instanceof ServiceH14AuditBudgetError || (error instanceof CertifiedLimit && error.reason==='managed_payload_ceiling'))code='memory';
      if(error instanceof CurrentBatchContractError)code='protocol';
      if(!closed){
        const message=error instanceof PreviewSourceError ? error.at('worker').message : (error instanceof Error?error.message:String(error)).slice(0,1024);
        if(request?.type==='calculate')post({type:'error',...context(request),profile:SERVICE_H14_PROFILE,code,message});
        else post({type:'initError',generation:request?.generation??0,profile:SERVICE_H14_PROFILE,message});
        closed=true;
      }
    }finally{try{ownedAdmission?.release();}finally{if(owns)busy=false;}}
  }
  return {handle,close(){closed=true;}};
}
