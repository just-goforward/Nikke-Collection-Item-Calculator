import { cmp, fromBinary64, fromWire, toNumber, type Q } from '../../shared/certifiedRational.ts';
import { eventOffset, futureEvents } from '../certified/events.ts';
import { PRACTICAL_TARGETS, STRICT_TARGETS, type AccuracyTargets, type ApproxAccuracy, type ApproxDate, type ServiceH14Input, type ApproxSelection, type Bound, type JointSourcePlan } from './types.ts';

export function boundError(value: Bound): number {
  return Math.max(value.estimate-value.lower,value.upper-value.estimate);
}

/** The row accuracy contract is independent of whether all 15 dates finished. */
export function rowsMeetTargets(records:readonly ApproxDate[], priceSum:number, targets:AccuracyTargets):boolean {
  return records.every(record=>
    boundError(record.value.p)<=targets.probability&&boundError(record.value.c)<=targets.pieces&&
    record.value.consumed.every(value=>boundError(value)<=targets.pieces)&&
    boundError(record.value.b)<=targets.pieces*priceSum&&
    [record.risk.insufficientGainMass,record.risk.noFurtherWaitCertifiedMass,record.risk.renewedWaitUpperBound].every(value=>boundError(value)<=targets.risk));
}

export function assessAccuracy(records: readonly ApproxDate[], prices: readonly Q[], kind: ApproxAccuracy['kind'], confidence: ApproxAccuracy['confidence']):ApproxAccuracy {
  let maxProbabilityWidth=0,maxPieceWidth=0,maxRiskWidth=0;
  const priceSum=prices.reduce((sum,price)=>sum+toNumber(price),0);
  const complete=records.length===15&&records.every((record,index)=>record.day===index);
  const meets=(targets:AccuracyTargets)=>complete&&rowsMeetTargets(records,priceSum,targets);
  for(const record of records){
    maxProbabilityWidth=Math.max(maxProbabilityWidth,record.value.p.upper-record.value.p.lower);
    maxPieceWidth=Math.max(maxPieceWidth,record.value.c.upper-record.value.c.lower,...record.value.consumed.map(value=>value.upper-value.lower));
    for(const value of [record.risk.insufficientGainMass,record.risk.noFurtherWaitCertifiedMass,record.risk.renewedWaitUpperBound])
      maxRiskWidth=Math.max(maxRiskWidth,value.upper-value.lower);
  }
  return {kind,confidence,practical:meets(PRACTICAL_TARGETS),strict:meets(STRICT_TARGETS),maxProbabilityWidth,maxPieceWidth,maxRiskWidth};
}

function unchangedSupply(input:ServiceH14Input,from:number,until:number):boolean {
  for(const event of futureEvents(input)){
    const day=eventOffset(input,event);
    if(day>from&&day<=until&&event.refs.some(ref=>ref.count>0))return false;
  }
  return true;
}

function componentOrder(a:ApproxDate,b:ApproxDate,key:'p'|'b'|'c'):number|null {
  const av=a.value[key],bv=b.value[key];
  const aq=a.exactObjective?.[key]?fromWire(a.exactObjective[key]):av.lower===av.upper?fromBinary64(av.lower):null;
  const bq=b.exactObjective?.[key]?fromWire(b.exactObjective[key]):bv.lower===bv.upper?fromBinary64(bv.lower):null;
  if(aq&&bq)return cmp(aq,bq);
  if(aq){
    if(cmp(aq,fromBinary64(bv.upper))>0)return 1;
    if(cmp(aq,fromBinary64(bv.lower))<0)return -1;
    return null;
  }
  if(bq){
    if(cmp(fromBinary64(av.lower),bq)>0)return 1;
    if(cmp(fromBinary64(av.upper),bq)<0)return -1;
    return null;
  }
  if(av.lower>bv.upper)return 1;
  if(av.upper<bv.lower)return -1;
  return null;
}

function constantObjectiveKey(plan: JointSourcePlan, day: number): string | null {
  const bounds = plan.dates[day];
  if (!bounds) return null;
  return bounds.minUnits.every((value,k) => value === bounds.maxUnits[k])
    ? 'point:' + plan.sid + ':' + bounds.minUnits.join(',') : null;
}

/** Proof of strict lexicographic improvement, not an epsilon tie-break. */
export function strictlyBetter(a:ApproxDate,b:ApproxDate):boolean {
  // Physical zero kits at a nonterminal state give P=0 on a strictly
  // positive event. No representable mass or numerical deficit is needed.
  if(b.positiveZeroKitWitness&&a.exactObjective){
    const target=fromWire(a.exactObjective.p);
    if(target.n===target.d)return true;
  }
  // The proof's baseline is an exact lower burden over the entire support.
  // Its positive-support face proves strictness, not a rounded mean deficit.
  const proof=b.strictBurdenProof;
  if(proof&&a.exactObjective&&
    cmp(fromWire(a.exactObjective.p),fromWire(proof.upper.objective.p))===0&&
    cmp(fromWire(a.exactObjective.b),fromWire(proof.upper.objective.b))<=0)return true;
  const probability=componentOrder(a,b,'p');
  if(probability!==0)return probability!==null&&probability>0;
  const burden=componentOrder(a,b,'b');
  if(burden!==0)return burden!==null&&burden<0;
  const pieces=componentOrder(a,b,'c');
  return pieces!==null&&pieces<0;
}

export function selectApproxHorizon(input:ServiceH14Input,records:readonly ApproxDate[],plan:JointSourcePlan):ApproxSelection {
  if(records.length!==15||records.some((record,index)=>record.day!==index))
    return {status:'INCOMPLETE',day:null,value:null,reason:'all_dates_not_completed'};
  const last=records[14]!;
  const lastPoint=constantObjectiveKey(plan,14);
  // The unchanged fixed-price optimal objective cannot decrease with additional
  // nonnegative inventory. Prove equality to D14 AND strictness at its predecessor.
  for(let day=0;day<=14;day++){
    const record=records[day]!;
    const point=constantObjectiveKey(plan,day);
    const equal=day===14||unchangedSupply(input,day,14)||
      (point!==null&&point===lastPoint)||
      (['p','b','c'] as const).every(key=>componentOrder(record,last,key)===0);
    if(equal&&(day===0||strictlyBetter(last,records[day-1]!)))
      return {status:'COMPLETE',day,value:record.value,reason:null};
  }
  return {status:'INCOMPLETE',day:null,value:null,reason:'horizon_order_not_certified'};
}
