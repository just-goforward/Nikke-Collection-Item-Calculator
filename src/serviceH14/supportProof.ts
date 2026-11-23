import { fromWire, type Q } from '../../shared/certifiedRational.ts';
import { BOX_LAWS, DISPATCH_CLASSES } from '../../shared/certifiedSupplyLaws.ts';
import { TERMINAL } from '../certified/game.ts';
import type { CertifiedEvidenceBudget, Triple } from '../certified/types.ts';
import type { JointSourcePlan, PositiveZeroKitWitness } from './types.ts';

/** Boolean full positive support cover, independent of quantized producer rows.
 * Dominated points may be discarded: capped addition and floor projection are
 * isotone. A bounded failure returns no proof, never a sampled frontier.
 * Frontiers are capped at 128 points; caller owns the bounded workspace.
 */
export function positiveSupportCover(plan:JointSourcePlan,day:number,check:()=>void):Triple[]|undefined {
  let work=0;
  const dominates=(a:Triple,b:Triple)=>a.every((n,k)=>n<=b[k]!);
  const insert=(out:Triple[],point:Triple):boolean=>{
    for(const old of out){if(++work>200_000)return false;if(dominates(old,point))return true;}
    for(let i=out.length-1;i>=0;i--)if(dominates(point,out[i]!))out.splice(i,1);
    if(out.length===128)return false;out.push(point);return true;
  };
  const result:Triple[]=[];
  for(let cohort=0;cohort<plan.cohortCount;cohort++){
    let frontier:Triple[]=[[Math.min(plan.stock[0],plan.pieceCaps[0]),Math.min(plan.stock[1],plan.pieceCaps[1]),Math.min(plan.stock[2],plan.pieceCaps[2])]];
    for(const event of plan.descriptor.events){
      if(event.day>day)continue;
      for(const ref of event.refs){
        if(!ref.count)continue;
        check();
        const finite=plan.descriptor.laws.find(l=>l.id===ref.lawId&&l.kind==='finite');
        let rows:readonly {pieces:Triple}[];
        if(finite){
          const outcomes=finite.outcomesByCohort?finite.outcomesByCohort[cohort]:finite.outcomes;
          if(!outcomes)return undefined;
          const law:Triple[]=[];
          for(const row of outcomes){check();if(fromWire(row.mass).n>0n&&!insert(law,row.pieces))return undefined;}
          rows=law.map(pieces=>({pieces}));
        }else if(ref.lawId==='regular-box-v1')rows=BOX_LAWS.regular;
        else if(ref.lawId==='box-ii-v1')rows=BOX_LAWS.boxII;
        // A lower cover, NOT a claim that a zero dispatch is reachable.
        // Every physical dispatch payout is nonnegative.
        else if(ref.lawId==='dispatch-board-v1')rows=[{pieces:[0,0,0]}];
        else {
          const match=/^deterministic:(\d+),(\d+),(\d+)$/.exec(ref.lawId);
          if(!match)return undefined;
          rows=[{pieces:[Number(match[1]),Number(match[2]),Number(match[3])]}];
        }
        if(!rows.length)return undefined;
        for(let n=0;n<ref.count;n++){
          check();const next:Triple[]=[];
          for(const a of frontier)for(const b of rows){
            // Clamp before addition: both operands remain safe bounded integers.
            const point:Triple=[a[0]+Math.min(b.pieces[0],plan.pieceCaps[0]-a[0]),a[1]+Math.min(b.pieces[1],plan.pieceCaps[1]-a[1]),a[2]+Math.min(b.pieces[2],plan.pieceCaps[2]-a[2])];
            if(!insert(next,point))return undefined;
          }
          frontier=next;
        }
      }
    }
    for(const point of frontier)if(!insert(result,[Math.floor(point[0]/10),Math.floor(point[1]/10),Math.floor(point[2]/10)]))return undefined;
  }
  return result.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
}

/** Existential PHYSICAL support, distinct from the lower cover above.
 * All retained states are actual joint raw gains, never coordinate minima.
 * False/undefined means only "no proof": work refusal is not support absence.
 * A positive joint zero permits skipping repetitions; otherwise each draw
 * adds at least one piece, so a feasible path has at most 27 draws.
 */
export function positiveZeroKitWitness(
  plan:JointSourcePlan,day:number,priors:readonly Q[],budget:CertifiedEvidenceBudget,
  charge:(operations:number)=>void=()=>{},
):PositiveZeroKitWitness|undefined {
  charge(32);
  budget.check();
  if(plan.sid===TERMINAL||plan.stock.some(n=>n>=10)||!plan.dates[day])return undefined;
  const workspace=16_384;
  try{
    budget.reserve(workspace);
    charge(8192);
    const room=plan.stock.map(n=>9-n);
    let frontier=new Uint16Array(1000),next=new Uint16Array(1000);
    const rows=new Uint16Array(1000),seen=new Uint8Array(1000),rowSeen=new Uint8Array(1000);
    let work=0;
    const step=()=>{
      charge(32);
      if((++work&127)===0)budget.check();
      return work<=200_000;
    };
    for(let cohort=0;cohort<plan.cohortCount;cohort++){
      if(!step())return undefined;
      // Exact positivity survives arbitrarily small priors and row masses.
      if(!priors[cohort]||priors[cohort]!.n<=0n)continue;
      frontier[0]=0;let size=1,possible=true;
      for(const event of plan.descriptor.events){
        if(!step())return undefined;
        if(event.day>day)continue;
        for(const ref of event.refs){
          budget.check();
          if(!step())return undefined;
          if(ref.count===0)continue;
          let finite:typeof plan.descriptor.laws[number]|undefined;
          for(const law of plan.descriptor.laws){
            if(!step())return undefined;
            if(law.id===ref.lawId&&law.kind==='finite'){finite=law;break;}
          }
          charge(1000);rowSeen.fill(0);
          let count=0;
          const insert=(pieces:readonly number[])=>{
            if(pieces.some((n,k)=>n>room[k]!))return;
            const code=100*pieces[0]!+10*pieces[1]!+pieces[2]!;
            if(!rowSeen[code]){rowSeen[code]=1;rows[count++]=code;}
          };
          if(finite){
            const outcomes=finite.outcomesByCohort?finite.outcomesByCohort[cohort]:finite.outcomes;
            if(!outcomes)return undefined;
            for(const row of outcomes){
              if(!step())return undefined;
              if(typeof row.mass.numerator!=='string')return undefined;
              // Validated WireQ has nonnegative integer numerator and positive
              // denominator, but permits "00"/"-0". Scan exact nonzero digits
              // without rounding or allocating/multiplying huge rationals.
              charge(row.mass.numerator.length);
              if(/[1-9]/.test(row.mass.numerator))insert(row.pieces);
            }
          }else if(ref.lawId==='regular-box-v1'||ref.lawId==='box-ii-v1'){
            for(const row of ref.lawId==='regular-box-v1'?BOX_LAWS.regular:BOX_LAWS.boxII){
              if(!step())return undefined;
              if(row.mass.n>0n)insert(row.pieces);
            }
          }else if(ref.lawId==='dispatch-board-v1'){
            // drawPartialBoard has FOUR copies per class. Draw all four
            // copies of a positive-weight, raw-zero, discarded class: each
            // factor (4-count)*weight/total is strictly positive. keptBoards
            // discards all four, restoring that same empty start at every
            // reroll. The final board pays raw zero, including zero boxes.
            // This is one actual class path for every supported cohort,
            // not the synthetic nonnegative dispatch lower cover.
            let zero=false;
            for(const cls of DISPATCH_CLASSES){
              if(!step())return undefined;
              if(cls.weight>0&&!cls.keep&&cls.raw.every(n=>n===0)){zero=true;break;}
            }
            if(!zero)return undefined;
            insert([0,0,0]);
          }else{
            const match=/^deterministic:(\d+),(\d+),(\d+)$/.exec(ref.lawId);
            if(!match)return undefined;
            insert([Number(match[1]),Number(match[2]),Number(match[3])]);
          }
          if(rowSeen[0])continue;
          if(count===0){possible=false;break;}
          let minimum=28;
          for(let i=0;i<count;i++){
            if(!step())return undefined;
            const code=rows[i]!;
            minimum=Math.min(minimum,Math.floor(code/100)+Math.floor(code/10)%10+code%10);
          }
          // Division avoids overflow for enormous legal repetition counts.
          if(ref.count>Math.floor((room[0]!+room[1]!+room[2]!)/minimum)){possible=false;break;}
          for(let draw=0;draw<ref.count;draw++){
            budget.check();
            charge(1000);seen.fill(0);let nextSize=0;
            for(let i=0;i<size;i++)for(let j=0;j<count;j++){
              if(!step())return undefined;
              const a=frontier[i]!,b=rows[j]!;
              const x=Math.floor(a/100)+Math.floor(b/100);
              const y=Math.floor(a/10)%10+Math.floor(b/10)%10,z=a%10+b%10;
              if(x>room[0]!||y>room[1]!||z>room[2]!)continue;
              const code=100*x+10*y+z;
              if(!seen[code]){seen[code]=1;next[nextSize++]=code;}
            }
            const swap=frontier;frontier=next;next=swap;size=nextSize;
            if(size===0){possible=false;break;}
          }
          if(!possible)break;
        }
        if(!possible)break;
      }
      if(possible)return {cohort};
    }
    return undefined;
  }finally{budget.release(workspace);}
}
