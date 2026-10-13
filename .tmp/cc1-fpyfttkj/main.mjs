import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {evaluate,q,wire,Refusal,canonical,transition,probability} from "./evaluator.mjs";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {isDeepStrictEqual} from "node:util";
const hash=b=>createHash("sha256").update(b).digest("hex");
function same(a,b) {
  return BigInt(a.numerator)*BigInt(b.denominator)===BigInt(b.numerator)*BigInt(a.denominator);
}
function requireThat(condition,reason) {if(!condition) throw new Error(reason);}
function currentParity(expected,current) {
  requireThat(current.status==="use_certified","current_status");
  for(const [a,b] of [["P","successP"],["B","weightedExpectedConsumptionB"],["C","expectedTotalConsumptionC"]])
    requireThat(same(expected[a],current.value[b]),"current_"+a);
  requireThat(expected.consumed.every((v,i)=>same(v,current.value.expectedConsumed[i])),"current_consumed");
  requireThat(expected.mask===current.optimalActionMask,"current_mask");
  requireThat(["blue","purple","yellow"].indexOf(current.kit)===expected.chosen,"current_chosen");
}
function intervalParity(P,waiting) {
  requireThat(waiting.rangeBoundary&&waiting.bestDayRange?.[0]===56&&
    waiting.bestDayRange?.[1]===56&&waiting.value===null,"interval_boundary");
  requireThat(same(waiting.successProbabilityInterval.lower,P)&&
    same(waiting.successProbabilityInterval.upper,{numerator:"1",denominator:"1"}),"interval_endpoints");
  requireThat(same(waiting.successImprovementUpperBound,{
    numerator:String(BigInt(P.denominator)-BigInt(P.numerator)),denominator:P.denominator}),"interval_gap");
}
async function endpointsFor(group,job) {
  const deadline=performance.now()+job.wallMs;
  const prices=group.prices.map(p=>q(p.numerator,p.denominator));
  const relaxedAnswers={};
  if(job.relaxation) {
    const {evaluatePublicLayeredFeasibility}=await import("../../scripts/certified-staging-oracle-public-layered-feasibility.ts");
    for(const endpoint of group.endpoints) {
      const result=evaluatePublicLayeredFeasibility({...endpoint,prices,finiteColors:[0]},{
        deadlineAt:Math.min(deadline,performance.now()+job.relaxation.perCallMs),
        maxLiveRows:900,maxLogicalBytes:job.relaxation.logicalBytes,
      });
      if(result.status!=="PASS") {
        // Resource admissions are a fallback condition; unexpected helper
        // exceptions are integrity failures, never concealed by fallback.
        if(result.rawException&&!/admission|budget|deadline/.test(result.reason??""))
          throw new Error("relaxation_exception:"+result.reason);
        break;
      }
      requireThat(result.allOptimalPoliciesFit===true&&result.value&&result.relaxed,"relaxation_certificate");
      requireThat(result.diagnostics.cumulativeRows<=job.relaxation.maxRowsPerCall&&
        result.diagnostics.peakLiveRows<=900,"relaxation_work_bound");
      requireThat([1,2].every(k=>result.relaxed.worstAll[k]<=Math.floor(endpoint.stock[k]/10)),"relaxation_omitted_stock");
      const value=result.value;
      requireThat(value.P.n===value.P.d&&value.mask>0&&value.mask<=7&&
        value.chosen===[0,1,2].find(k=>value.mask&(1<<k)),"relaxation_endpoint");
      relaxedAnswers[endpoint.id]=wire({P:value.P,B:value.B,C:value.C,
        consumed:value.consumed,mask:value.mask,chosen:value.chosen});
    }
    if(Object.keys(relaxedAnswers).length===group.endpoints.length)
      return {answers:relaxedAnswers,trusted:Object.keys(relaxedAnswers)};
  }
  const {answers}=evaluate(group.root,prices,group.endpoints,
    {rows:job.rows,live:job.live,deadline});
  for(const [id,value] of Object.entries(relaxedAnswers))
    requireThat(isDeepStrictEqual(value,answers[id]),"relaxation_finite_full_endpoint_mismatch");
  return {answers,trusted:[]};
}
export async function main(mode="main") {
  const data=JSON.parse(readFileSync(new URL("./obligations.json",import.meta.url)));
  const source=readFileSync(resolve(fileURLToPath(new URL("../../",import.meta.url)),data.observations[0].source));
  requireThat(hash(source)===data.sourceSha256,"observation_source_pin");
  const outcomes=[];
  const endpointEvidence=[];
  requireThat(data.observations.length===72&&Object.keys(data.groups).length===6&&
    data.intervalChecks.length===48&&new Set(data.observations.map(o=>o.byteOffset)).size===72&&
    Object.values(data.groups).filter(g=>g.currentProof==="new").length===4&&
    Object.values(data.groups).reduce((n,g)=>n+g.endpoints.filter(e=>/_k\d+$/.test(e.id)).length,0)===33,"cardinalities");
  requireThat(Object.keys(data.groups).every(g=>data.observations.filter(o=>o.group===g).length===12)&&
    Object.values(data.groups).reduce((n,g)=>n+g.endpoints.length,0)===37&&
    new Set(data.observations.map(o=>o.id)).size===72&&
    new Set(data.intervalChecks.map(c=>c.id)).size===48,"obligation_uniqueness");
  let telemetry=null;
  for(const job of data.resources.jobs) {
    if(mode==="calibrate"&&job.id!=="B14") continue;
    if(!job.admitted) {outcomes.push(job.id+":NOTRUN_estimated_heap_budget");continue;}
    const group=data.groups[job.id];
    try {
      let answers;
      if(mode==="calibrate") {
        const started=performance.now();
        const computed=evaluate(group.root,group.prices.map(p=>q(p.numerator,p.denominator)),group.endpoints,
          {rows:job.rows,live:job.live,deadline:started+job.wallMs});
        const elapsedMs=performance.now()-started;
        answers=computed.answers;telemetry={rows:computed.rows,elapsedMs,rowsPerSecond:computed.rows*1000/elapsedMs,certifying:false};
        endpointEvidence.push(...group.endpoints.map(e=>({id:e.id,relaxationTrusted:false})));
      } else {
        const solved=await endpointsFor(group,job);answers=solved.answers;
        endpointEvidence.push(...group.endpoints.map(e=>({id:e.id,relaxationTrusted:solved.trusted.includes(e.id)})));
      }
      for(const observation of data.observations.filter(o=>o.group===job.id)) {
        const bytes=source.subarray(observation.byteOffset,observation.byteOffset+observation.byteLength);
        requireThat(hash(bytes)===observation.sha256,"observation_record_pin");
        const record=JSON.parse(bytes);
        requireThat(record.independent.pricing.status==="PASS","pricing_not_pass");
        requireThat(group.prices.every((p,i)=>same(p,record.output.pricing.weights[i])),"prices");
        const initial=group.inputRoot??group.root;
        requireThat(["grade","level","exp"].every(k=>record.input[k]===initial[k])&&
          isDeepStrictEqual(record.input.stock,initial.stock),"input_correspondence");
        const independent=answers[observation.currentRoot];
        if(group.currentProof==="new") {requireThat(independent,"current_missing");currentParity(independent,record.output.current);}
        else {
          requireThat(group.currentProof==="recorded_current_PASS","current_proof_branch");
          requireThat(record.independent.current.status==="PASS","recorded_current_missing");
          const color=["blue","purple","yellow"].indexOf(record.output.current.kit);
          requireThat(color>=0,"recorded_current_color");
          const next=transition(canonical(record.input),color,false);
          const nextStock=record.input.stock.map((n,k)=>n-(k===color?10:0));
          requireThat(["grade","level","exp"].every(k=>next[k]===group.root[k])&&
            isDeepStrictEqual(nextStock,group.root.stock),"derived_root_correspondence");
        }
        const chosen=independent?.chosen??["blue","purple","yellow"].indexOf(record.output.current.kit);
        // First prove all predeclared continuation memberships. If the initial
        // action differs, currentParity fails; no candidate action drives the DP.
        requireThat(chosen>=0&&chosen<3,"chosen_color");
        const start=canonical(record.input);let state=start,stock=[...record.input.stock],uses=0;
        while(uses<(record.input.batchLimit??10)) {
          if(uses>0) {
            const e=group.endpoints.find(e=>e.grade===state.grade&&e.level===state.level&&e.exp===state.exp&&isDeepStrictEqual(e.stock,stock));
            if(!e||!answers[e.id]) throw new Refusal("prefix_endpoint_missing");
            if(!(answers[e.id].mask&(1<<chosen))) break;
          }
          uses++;stock[chosen]-=10;
          if(probability(state,chosen)===1000) break;
          state=transition(state,chosen,false);
          if(state.grade!==start.grade||state.level!==start.level||
            (state.grade==="SR"&&state.level===15)) break;
        }
        requireThat(record.output.current.uses===uses&&record.output.current.pieces===10*uses,"batch_length");
        if(observation.intervalCheck) {
          requireThat(independent,"interval_without_current");
          requireThat(record.independent.waiting.status==="PASS","historical_witness_not_pass");
          intervalParity(independent.P,record.output.waiting);
        }
      }
      outcomes.push(job.id+":PASS_historical_witness_retained");
    } catch(error) {
      if(error instanceof Refusal) outcomes.push(job.id+":NOTRUN_"+error.message);
      else throw error;
    }
  }
  return {status:outcomes.some(x=>x.includes(":NOTRUN"))?"NOTRUN":"PASS",
    reason:outcomes.join(";")+(telemetry?";B14_calibration="+JSON.stringify(telemetry):""),
    endpoints:endpointEvidence};
}
