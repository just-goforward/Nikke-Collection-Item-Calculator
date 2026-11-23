import { EDGES, KIT_INDICES, TERMINAL, type KitIndex, type StateId } from '../certified/game.ts';
import type { CertifiedEvidenceBudget } from '../certified/types.ts';

const S=2**30, CAP=65_536, BYTES=CAP*8+64*1024;
/** Bound U(best policy)-U(use k) independently of the supply distribution.
 * Prepay k now, shadow the comparator's waits and all its rolls except its
 * first k, which uses our reserved uniform. Until that skip, no other stock
 * differs. After terminal, no extra waits need be paid. Expose both states and
 * even our prepaid outcome to an inventory-unrestricted adversary: only a
 * comparator-only success can cost utility. Dropping waits (self-loops) and
 * STOP (no such success) bounds this probability. Actual coupled observations
 * can be generated conditionally without observing any future supplies. */
export function exchangeUpper(sid:StateId,k:KitIndex,budget:CertifiedEvidenceBudget):number {
  try{
    budget.reserve(BYTES);
    const keys=new Uint32Array(CAP),values=new Uint32Array(CAP);
    const [first,great,normal]=EDGES[sid][k];let low=0,high=first,count=0;
    function upper(v:number,r:number,debt:boolean):number {
      if(r===TERMINAL)return 0;
      if(v===TERMINAL)return S;
      // With no outstanding action and the real state ahead, shared-uniform
      // draws preserve the order on each reachable grade chain (R15 -> SR5).
      if(!debt&&r>=v)return 0;
      const key=(v*601+r)*3+(debt?(low===0?1:2):0)+1;
      let slot=(Math.imul(key,0x9e3779b1)>>>16);
      while(keys[slot]&&keys[slot]!==key)slot=(slot+1)&(CAP-1);
      if(keys[slot])return values[slot]!;
      if(count>=CAP/2)return S; // Unexplored subtrees count full loss.
      if((count++ & 255)===0)budget.check();
      keys[slot]=key; // v strictly advances: this in-progress node cannot recur.
      let worst=0;
      for(const j of KIT_INDICES){
        const [p,g,n]=EDGES[v as StateId][j];let sum:number,den=1000;
        if(debt&&j===k){
          den=high-low;const m=Math.max(0,Math.min(high,p)-low);
          sum=(m?m*upper(g,r,false):0)+(den>m?(den-m)*upper(n,r,false):0);
        }else{
          const [t,h,m]=EDGES[r as StateId][j],both=Math.min(p,t),neither=1000-Math.max(p,t);
          sum=(both?both*upper(g,h,debt):0)+(p>t?(p-t)*upper(g,m,debt):t>p?(t-p)*upper(n,h,debt):0)+(neither?neither*upper(n,m,debt):0);
        }
        // Numerators <= 1000*2^30 are exact binary64 integers.
        const rem=sum%den;worst=Math.max(worst,(sum-rem)/den+Number(rem!==0));if(worst===S)break;
      }
      values[slot]=worst;return worst;
    }
    let sum=first*upper(sid,great,true);
    if(first<1000){low=first;high=1000;sum+=(1000-first)*upper(sid,normal,true);}
    const rem=sum%1000;return ((sum-rem)/1000+Number(rem!==0))/S;
  }finally{budget.release(BYTES);}
}
