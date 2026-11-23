import { GAME_DAY_MS } from '../../shared/gameDay.ts';
import { exchangeUpper } from './adaptiveExchange.ts';
import { ONE, ZERO, add, cmp, fromBinary64, fromWire, mul, q, qInterval, sub, toNumber, type Q } from '../../shared/certifiedRational.ts';
import { EDGES, TERMINAL, encode, type StateId } from '../certified/game.ts';
import type { CertifiedEvidenceBudget } from '../certified/types.ts';
import type { ServiceH14Admission } from './admission.ts';
import { AdaptiveSourceUnavailable, createAdaptiveSource } from './adaptiveSource.ts';
import { rowsMeetTargets } from './selection.ts';
import { isCertifiedPrefixStop } from './source.ts';
import { PRACTICAL_TARGETS, type ServiceH14Input, type ServiceH14Output } from './types.ts';

const lambda=q(1,400), kits=['blue','purple','yellow'] as const;
const max=(a:Q,b:Q)=>cmp(a,b)>=0?a:b, min=(a:Q,b:Q)=>cmp(a,b)<=0?a:b;
export function classifyAdaptiveDelta(lo:Q,hi:Q) {
  if(cmp(lo,hi)>0)throw Error('adaptive_inconsistent_scores');
  return {mathematical:cmp(lo,ZERO)>0?'wait':cmp(hi,ZERO)<=0?'use_now':'unresolved',
    actionable:cmp(lo,lambda)>0?'wait':cmp(hi,lambda)<=0?'no_material_wait':'unresolved'} as const;
}
// Between arrivals a successful run that hasn't finished must pay actual elapsed time.
// At an intermediate prefix its day's final success is only an UPPER envelope:
// extra inventory may be ignored. Never use that row as an attainable witness early.
type Epoch={day:number;elapsed:Q};
function ceiling(rows:Q[],epochs:Epoch[],wait:boolean,budget:CertifiedEvidenceBudget) {
  const p=rows.at(-1)!;let delay=ZERO,previous=ZERO,upper=rows[0]!;
  for(const [i,epoch] of epochs.entries()){
    budget.check();
    const crossing=wait&&i===0?ONE:max(ZERO,sub(p,upper));
    delay=add(delay,mul(sub(epoch.elapsed,previous),crossing));
    previous=epoch.elapsed; upper=rows[epoch.day]!;
  }
  return sub(p,mul(lambda,delay));
}
/** The shorter prefix can choose the longer witness as its continuation, never conversely. */
export function certifiedPrefixCount(limit:number,whole:Q,waitUpper:Q,prefixLower:(n:number)=>Q|null){
  for(let n=limit;n>0;n--){
    const lower=n===limit?whole:prefixLower(n);
    if(lower&&cmp(sub(waitUpper,lower),lambda)<=0)return n;
  }
  return 0;
}
export function adaptiveDecision(input:ServiceH14Input,admission:ServiceH14Admission,out:ServiceH14Output,budget:CertifiedEvidenceBudget,usePortable=false){
  if(out.status!=='complete'||out.reason!==null||!out.accuracy.practical||out.records.length!==15)return undefined;
  return scoreWindow(input,admission,out,budget,14,usePortable);
}

/** An explicitly shorter question, not a partial answer to the H14 policy. */
export function adaptivePrefixDecision(input:ServiceH14Input,admission:ServiceH14Admission,out:ServiceH14Output,budget:CertifiedEvidenceBudget){
  const horizon=out.records.length-1;
  if(out.status!=='incomplete'||!isCertifiedPrefixStop(out.reason)||horizon<1||horizon>=14||!out.pricingWeights||
    !rowsMeetTargets(out.records,out.pricingWeights.reduce((s,p)=>s+toNumber(fromWire(p)),0),PRACTICAL_TARGETS))return undefined;
  const verdict=scoreWindow(input,admission,out,budget,horizon,false);
  return verdict?{horizon,verdict}:undefined;
}

function scoreWindow(input:ServiceH14Input,admission:ServiceH14Admission,out:ServiceH14Output,budget:CertifiedEvidenceBudget,horizon:number,usePortable:boolean){
  if(out.records.some((r,d)=>r.day!==d||r.prefixKey!==admission.plan.dates[d]?.prefixKey)||
    out.sourceCertificate?.completedThrough!==horizon||!out.current||out.current.status==='complete'||!input.stock.some(p=>p>=10))return undefined;
  const current=out.current, kit=out.current.kit;
  let source;try{source=createAdaptiveSource(input,admission,budget,horizon);}catch(e){if(e instanceof AdaptiveSourceUnavailable)return undefined;throw e;}
  try{
    const first=source.epochs[0];if(!first)return undefined;
    const asOf=Date.parse(input.asOf);
    const epochs=source.epochs.map(({day,at})=>({day,elapsed:q(at-asOf,GAME_DAY_MS)}));
    const firstDelay=epochs[0]!.elapsed;
    // Only after the last receipt in a row is its entire inventory available.
    const attained:Q[]=Array(horizon+1).fill(ZERO);
    for(const e of epochs)attained[e.day]=e.elapsed;
    for(let d=1;d<=horizon;d++)if(!attained[d]!.n)attained[d]=attained[d-1]!;
    const rows=out.records, upper=rows.map(r=>fromBinary64(r.value.p.upper));
    const p0=fromWire(current.value.successP);upper[0]=p0;
    const sid=encode(input.grade,input.level,input.exp) as StateId;
    let waitLo=sub(ZERO,mul(firstDelay,lambda)),waitHi=ceiling(upper,epochs,true,budget);
    for(let d=first.day;d<=horizon;d++)waitLo=max(waitLo,sub(fromBinary64(rows[d]!.value.p.lower),mul(lambda,attained[d]!)));
    const candidates=kits.flatMap((color,k)=>{
      if(input.stock[k]!<10)return [];
      const u=upper.slice(),[rate,g,n]=EDGES[sid][k as 0|1|2];
      let remain=q(1000-(g===TERMINAL?rate:0)-(n===TERMINAL?1000-rate:0),1000);
      let lower=sub(ONE,remain),limit=1;
      if(color===kit){
        // Verified Current follows exact D0-optimal actions on its normal path.
        // Its entire path followed by immediate optimal play attains p0.
        let s:StateId=sid;
        let normalMass=ONE,earlySuccess=ZERO;
        const cap=Math.min(current.uses,input.batchLimit??10,10,Math.floor(input.stock[k]!/10));
        const nextLevel=sid-input.exp/100+(sid<150?10:30);
        for(limit=0;limit<cap;){
          const [p,great,normal]=EDGES[s][k as 0|1|2];limit++;
          if(great===TERMINAL)earlySuccess=add(earlySuccess,mul(normalMass,q(p,1000)));
          normalMass=mul(normalMass,q(1000-p,1000));
          if(normal===TERMINAL)earlySuccess=add(earlySuccess,normalMass);
          if(p===1000||normal>=nextLevel)break;
          s=normal as StateId;
        }
        if(limit<1)throw Error('adaptive_invalid_path');
        remain=sub(ONE,earlySuccess);lower=max(earlySuccess,p0);
        for(let d=1;d<=horizon;d++){
          const row=rows[d]!, b=row.batchEvidence;
          if(!b||b.day!==d||b.kit!==kit||b.uses!==current.uses||b.prefixKey!==row.prefixKey)throw Error('adaptive_missing_forced_evidence');
          // Following the entire published batch is feasible after its first use;
          // only a one-use batch can also upper-bound the forced-first optimum.
          const forced=max(ZERO,sub(fromBinary64(row.value.p.lower),fromBinary64(b.mean.upper)));
          lower=max(lower,sub(forced,mul(mul(lambda,attained[d]!),remain)));
          if(b.uses===1)u[d]=sub(u[d]!,fromBinary64(b.mean.lower));
        }
      }
      let hi=ceiling(u,epochs,false,budget);
      if(usePortable&&admission.portableToll){
        const proof=admission.portableToll(sid,input.stock,k,limit,()=>budget.check());
        if(proof&&'lower' in proof){
          lower=max(lower,fromBinary64(proof.lower));waitHi=min(waitHi,fromBinary64(proof.upper));
        }else if(proof){
          hi=min(hi,fromBinary64(proof.nowUpper));waitLo=max(waitLo,fromBinary64(proof.waitLower));
        }
      }
      if(cmp(lower,hi)>0)throw Error('adaptive_invalid_color_bounds');
      return [{color,k,lower,hi,limit,certified:0}];
    });
    if(!candidates.length)throw Error('adaptive_no_current_action');
    for(const c of candidates){
      // The row evidence is for the full published batch, not the best first
      // color. Every current-prefix limit <= that length inherits this lower.
      // If insufficient, integrate actual shorter branches, never scale a gap.
      const initialWait=waitHi,whole=c.lower;
      const shorter=(n:number)=>{
        if(!usePortable||!admission.portableToll)return null;
        const proof=admission.portableToll(sid,input.stock,c.k,n,()=>budget.check());
        if(!proof||!('lower' in proof))return null;
        waitHi=min(waitHi,fromBinary64(proof.upper));
        const lower=fromBinary64(proof.lower);c.lower=max(c.lower,lower);
        return lower;
      };
      c.certified=certifiedPrefixCount(c.limit,whole,initialWait,shorter);
      // A missing full endpoint may be the only affordable color. Its first
      // available shorter endpoint also supplies the previously missing WAIT
      // gate. Reconsider larger prefixes under that sharper upper bound.
      if(cmp(waitHi,initialWait)<0)c.certified=certifiedPrefixCount(c.limit,whole,waitHi,shorter);
      if(cmp(c.lower,c.hi)>0)throw Error('adaptive_invalid_color_bounds');
    }
    const nowLo=candidates.reduce((v,c)=>max(v,c.lower),ZERO),nowHi=candidates.reduce((v,c)=>max(v,c.hi),ZERO);
    // Delay the NOW policy's whole initial prefix, ignoring the new receipt
    // until the shadow requests it. Only paths that never waited pay extra.
    // At most p0 of its success mass could have completed before any wait.
    const replay=sub(ZERO,mul(mul(firstDelay,lambda),sub(ONE,max(ZERO,sub(nowLo,p0)))));
    const lo=max(sub(waitLo,nowHi),replay);let hi=sub(waitHi,nowLo);
    const lastLevel=input.grade==='SR'&&input.level===14;
    // In SR14 all greats terminate and ordinary XP increments commute. Pre-use
    // today's inventory in any order before shadowing the WAIT policy. On an
    // all-miss nonterminal path the residual state is identical after its uses;
    // per-color trial prefixes can be hidden until the shadow asks. Every D0
    // success saves at least the first delay, with no other path paying more.
    if(lastLevel)hi=min(hi,sub(ZERO,mul(mul(lambda,firstDelay),p0)));
    else if(cmp(hi,ZERO)>0)for(const k of [0,1,2] as const){
      if(input.stock[k]<10)continue;
      hi=min(hi,fromBinary64(exchangeUpper(sid,k,budget)));
      if(hi.n===0n)break;
    }
    const decision=classifyAdaptiveDelta(lo,hi);
    const winner=candidates.find(c=>candidates.every(b=>c===b||cmp(c.lower,b.hi)>0));
    const firstKit=decision.mathematical==='use_now'?(lastLevel?kit:winner?.color??null):null;
    // This is a claim about ONE affordable color's continuation score, not
    // the best-color gap and not Current optimality. Prefer Current only among
    // individually certified witnesses. Strict actions keep their own identity.
    const qualifies=(c:typeof candidates[number])=>cmp(sub(waitHi,c.lower),lambda)<=0;
    const practicalFirstKit=!firstKit&&decision.actionable==='no_material_wait'?
      (candidates.find(c=>c.color===kit&&qualifies(c))??candidates.find(qualifies))?.color??null:null;
    const chosen=candidates.find(c=>c.color===(firstKit??practicalFirstKit));
    const practicalBatchUses=chosen?Math.max(1,chosen.certified):0;
    return {...decision,firstKit,practicalFirstKit,practicalBatchUses,nextDay:first.day,nextAt:new Date(first.at).toISOString(),
      delta:{lower:qInterval(lo).lo,upper:qInterval(hi).hi}};
  }finally{source.release();}
}
