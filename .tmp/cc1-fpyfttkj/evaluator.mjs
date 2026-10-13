// Independent recurrence; constants transcribed from shared/game.ts.
// Trust assumption: those public EXP/probability constants are authoritative.
// Does not import any product solver. Not yet runtime-validated.
export class Refusal extends Error {}
const rates = {
  R: [
    [176,208,240,272,400,160,192,224,272,400,144,176,224,272,400],
    [550,650,750,850,1000,500,600,700,850,1000,450,550,700,850,1000],
    Array(15).fill(1000),
  ],
  SR: [
    [36,59,78,113,150,22,33,49,76,125,12,22,31,47,100],
    [110,198,287,413,550,80,120,180,280,500,54,99,144,216,450],
    [250,400,550,750,1000,200,300,450,700,1000,150,275,400,600,1000],
  ],
};
function gcd(a,b) { while(b) [a,b]=[b,a%b]; return a; }
export function q(n,d=1n) {
  n=BigInt(n); d=BigInt(d);
  if(d<=0n) throw new Error("invalid_denominator");
  const g=gcd(n<0n?-n:n,d); return {n:n/g,d:d/g};
}
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const zero=()=>({P:0n,B:0n,C:0n,consumed:[0n,0n,0n],mask:0,chosen:-1});
function compare(a,b) { return cmp(a.P,b.P)||-cmp(a.B,b.B)||-cmp(a.C,b.C); }
export function canonical(s) {
  return s.grade==="R"&&s.level===15 ? {grade:"SR",level:5,exp:0} : s;
}
const stateKey=s=>`${s.grade}:${s.level}:${s.exp}`;
export function transition(s,k,great) {
  if(great) return canonical({grade:s.grade,level:(Math.floor(s.level/5)+1)*5,exp:0});
  let level=s.level,exp=s.exp+[200,500,1000][k];
  const required=s.grade==="R"?1000:3000;
  while(level<15&&exp>=required) {
    exp-=required; level++;
    if(level%5===0) { exp=0; break; }
  }
  return canonical({grade:s.grade,level,exp});
}
function validate(s) {
  if(!["R","SR"].includes(s.grade)||!Number.isInteger(s.level)||s.level<0||s.level>15||
    !Number.isInteger(s.exp)||s.exp<0||s.exp%100||
    s.exp>=(s.grade==="R"?1000:3000)||(s.level===15&&s.exp!==0))
    throw new Error("invalid_state");
}
export function wire(endpoint) {
  const w=a=>({numerator:String(a.n),denominator:String(a.d)});
  return {...endpoint,P:w(endpoint.P),B:w(endpoint.B),C:w(endpoint.C),consumed:endpoint.consumed.map(w)};
}
// Endpoints: [{id,grade,level,exp,stock}]. Prices are fixed for the entire table.
export const probability=(s,k)=>rates[s.grade][k][s.level];
// Reachability bitset + adjacent inventory-sum layers. All arithmetic inside
// the DP is integer arithmetic; rational reduction occurs only at endpoints.
export function evaluate(root, prices, endpoints, limits) {
  validate(root);
  if(root.stock.length!==3||root.stock.some(x=>!Number.isSafeInteger(x)||x<0||x>100000))
    throw new Error("invalid_stock");
  if(prices.length!==3||prices.some(x=>typeof x.n!=="bigint"||typeof x.d!=="bigint"||x.n<0n||x.d<=0n))
    throw new Error("invalid_prices");
  if(!limits||!Number.isFinite(limits.deadline)||!Number.isSafeInteger(limits.rows)||
     !Number.isSafeInteger(limits.live)||limits.rows<1||limits.live<1)
    throw new Error("missing_limits");
  const check=()=>{if(performance.now()>limits.deadline) throw new Refusal("deadline");};
  const nodes=[], ids=new Map();
  function visit(raw) {
    check(); const s=canonical(raw), key=stateKey(s);
    if(ids.has(key)) return ids.get(key);
    const id=nodes.length; ids.set(key,id);
    const node={s,edges:[],depth:0}; nodes.push(node);
    if(s.grade==="SR"&&s.level===15) return id;
    for(let k=0;k<3;k++) {
      const p=rates[s.grade][k][s.level];
      const great=visit(transition(s,k,true));
      const ordinary=p===1000?great:visit(transition(s,k,false));
      node.edges.push({p,great,ordinary});
      node.depth=Math.max(node.depth,1+nodes[great].depth,1+nodes[ordinary].depth);
    }
    return id;
  }
  const rootId=visit(root);
  const order=nodes.map((_,i)=>i).sort((a,b)=>nodes[a].depth-nodes[b].depth);
  const units=root.stock.map(x=>Math.floor(x/10));
  const widths=units.map(x=>x+1),box=widths.reduce((a,b)=>a*b,1);
  const key=(id,u)=>id*box+(u[0]*widths[1]+u[1])*widths[2]+u[2];
  const bits=new Uint8Array(Math.ceil(nodes.length*box/8));
  const reachable=k=>(bits[Math.floor(k/8)]&(1<<(k%8)))!==0;
  let discovered=0;
  function discover(id,u) {
    check();const k=key(id,u);
    if(reachable(k)) return;
    bits[Math.floor(k/8)]|=1<<(k%8);
    if(nodes[id].depth===0) return;
    if(++discovered>limits.rows) throw new Refusal("reachable_row_budget");
    for(let color=0;color<3;color++) if(u[color]>0) {
      const next=[...u];next[color]--;
      const e=nodes[id].edges[color];
      discover(e.great,next);
      if(e.p<1000) discover(e.ordinary,next);
    }
  }
  discover(rootId,units);
  const powers=[1n],total=units.reduce((a,b)=>a+b,0);
  for(let d=1;d<=total;d++) powers.push(powers[d-1]*1000n);
  const priceScale=prices.reduce((a,p)=>a*p.d,1n);
  const scaledPrices=prices.map(p=>p.n*(priceScale/p.d));
  function endpoint(value,layer) {
    const denominator=powers[layer];
    return wire({...value,P:q(value.P,denominator),B:q(value.B,denominator*priceScale),
      C:q(value.C,denominator),consumed:value.consumed.map(x=>q(x,denominator))});
  }
  const requests=new Map(), answers={};
  for(const e of endpoints) {
    validate(e);
    if(typeof e.id!=="string"||Object.hasOwn(answers,e.id)) throw new Error("invalid_endpoint_id");
    if(!Array.isArray(e.stock)||e.stock.length!==3||e.stock.some((x,i)=>
      !Number.isSafeInteger(x)||x<0||Math.floor(x/10)>units[i])) throw new Error("endpoint_stock");
    const id=ids.get(stateKey(canonical(e)));
    if(id===undefined) throw new Error("endpoint_outside_graph");
    const k=key(id,e.stock.map(x=>Math.floor(x/10)));
    if(!reachable(k)) throw new Error("endpoint_not_reachable");
    const list=requests.get(k)||[]; list.push(e.id); requests.set(k,list);
    answers[e.id]=null;
  }
  let previous=new Map(),rows=0,peak=0;
  for(let layer=0;layer<=units.reduce((a,b)=>a+b,0);layer++) {
    const current=new Map();
    for(let a=0;a<=units[0];a++) for(let b=0;b<=units[1];b++) {
      const c=layer-a-b; if(c<0||c>units[2]) continue;
      const u=[a,b,c];
      for(const id of order) {
        check(); const node=nodes[id], k=key(id,u);
        if(!reachable(k)) continue;
        if(node.depth===0) {
          for(const name of requests.get(k)||[]) answers[name]=endpoint({...zero(),P:powers[layer],chosen:-2},layer);
          continue;
        }
        if(++rows>limits.rows) throw new Refusal("row_budget");
        if(previous.size+current.size+1>limits.live) throw new Refusal("live_budget");
        let best=zero();
        for(let color=0;color<3;color++) {
          if(u[color]===0) continue;
          const v=[...u];v[color]--;
          const edge=node.edges[color];
          const child=i=>{
            if(nodes[i].depth===0) return {...zero(),P:powers[layer-1],chosen:-2};
            const result=previous.get(key(i,v));
            if(!result) throw new Error("missing_child");
            return result;
          };
          const g=child(edge.great), n=edge.p===1000?zero():child(edge.ordinary);
          const p=BigInt(edge.p), f=BigInt(1000-edge.p);
          const mix=(x,y)=>p*x+f*y;
          const value={
            P:mix(g.P,n.P), B:10n*scaledPrices[color]*powers[layer]+mix(g.B,n.B),
            C:10n*powers[layer]+mix(g.C,n.C),
            consumed:g.consumed.map((x,j)=>(j===color?10n*powers[layer]:0n)+mix(x,n.consumed[j])),
            mask:1<<color,chosen:color,
          };
          const comparison=compare(value,best);
          if(comparison>0) best=value;
          else if(comparison===0) best={...best,mask:best.mask|value.mask};
        }
        current.set(k,best);
        peak=Math.max(peak,previous.size+current.size);
        for(const name of requests.get(k)||[]) answers[name]=endpoint(best,layer);
      }
    }
    previous=current;
  }
  if(Object.values(answers).some(x=>x===null)) throw new Error("missing_endpoint");
  return {answers,rows,peak,reachableRows:discovered,reachabilityBytes:bits.byteLength};
}
