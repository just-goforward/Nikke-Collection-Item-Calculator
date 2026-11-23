import { adaptiveDecision, adaptivePrefixDecision } from './adaptiveDecision.ts';
import { positiveSupportCover } from './supportProof.ts';
import { assertCertifiedForecastIdentity, sameCertifiedForecastIdentity } from '../../shared/certifiedForecastIdentity.ts';
import { add, cmp, fromBinary64, fromWire, mul, q, sub, toNumber, type Q } from '../../shared/certifiedRational.ts';
import { isCertifiedEventClaimable } from '../../shared/certifiedSupply.ts';
import type { WorkBudget } from '../certified/budget.ts';
import { CAPS, encode, TERMINAL, type StateId } from '../certified/game.ts';
import { calculatePricing } from '../certified/pricing.ts';
import type { CertifiedCurrent, Triple } from '../certified/types.ts';
import { validate } from '../certified/validation.ts';
import { complementBound, makeApproxValue, ENDPOINT_PRUNE_BUDGET } from './aggregate.ts';
import { scanServiceJson, type ServiceH14Admission } from './admission.ts';
import { ServiceH14DeadlineError, serviceH14DeadlineMs } from './deadline.ts';
import { down, rationalBound, up } from './numeric.ts';
import { SERVICE_H14_PROFILE, assertServiceH14Profile } from './profile.ts';
import { assertJointSourceCertificate, certifyJointSourcePlan } from './sourcePlan.ts';
import { isCertifiedPrefixStop } from './source.ts';
import { assessAccuracy } from './selection.ts';
import { batchDecision } from './batchDecision.ts';
import type { ServiceH14Input, ServiceH14Output, ServiceH14Request, ApproxValue, Bound, BoundTriple, ExactObjective, JointSourcePlan } from './types.ts';

type Budget = { check(): void; reserve(bytes:number):void; release(bytes:number):void; checkPrefixTime?():void };
const VALIDATION_SCRATCH=8*1024*1024;
const VALIDATION_BYTES=VALIDATION_SCRATCH+512*1024;
const RUNTIME_BYTES=32*1024*1024;
/** Local audit allocation refusal, never a producer-reported protocol error. */
export class ServiceH14AuditBudgetError extends Error {
  constructor() { super('service_h14_audit_workspace'); this.name='ServiceH14AuditBudgetError'; }
}
/** Only the optional verdict lacked resources AFTER its rows passed all audits. */
export class ServiceH14PrefixBudgetError extends Error {}
export function isServiceH14ResourceReason(reason:string|null):boolean {
  return isCertifiedPrefixStop(reason)||reason==='certified_wasm_trap'||reason==='certified_wasm_allocation_trap'||reason==='certified_wasm_instance_failed';
}
function fail(part: string): never { throw new Error(`service_h14_binding_${part}`); }
function requireThat(condition: unknown, part: string): asserts condition { if (!condition) fail(part); }
function finite(value: unknown, min = 0, max = Number.MAX_VALUE): asserts value is number {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'number');
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  finite(value, min, max); requireThat(Number.isSafeInteger(value), 'integer');
}
function text(value: unknown, maximum = 1024, empty = false): asserts value is string {
  requireThat(typeof value === 'string' && value.length <= maximum && (empty || value.length > 0), 'string');
}
function nullableText(value: unknown): void { if (value !== null) text(value); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'object');
  let count = 0;
  for (const key in value) {
    requireThat(Object.hasOwn(value, key) && ++count <= required.length + optional.length &&
      (required.includes(key) || optional.includes(key)), 'keys');
    const property = Object.getOwnPropertyDescriptor(value, key);
    requireThat(property?.enumerable && 'value' in property, 'accessor');
  }
  for (const key of required) requireThat(Object.hasOwn(value, key), 'missing_key');
  // Enumerable properties have already been bounded; structured-clone messages
  // cannot carry hidden properties, symbols or proxies. Reject these on direct calls too.
  requireThat(Reflect.ownKeys(value).length === count, 'hidden_key');
}
function array(value: unknown, maximum: number, exact?: number): asserts value is unknown[] {
  requireThat(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'array');
  requireThat(value.length <= maximum && (exact === undefined || value.length === exact), 'array_length');
}

function wire(value: unknown, check: () => void): Q {
  object(value, ['numerator', 'denominator']);
  const numerator = value['numerator'], denominator = value['denominator'];
  text(numerator, 4096); text(denominator, 4096);
  requireThat(/^(0|[1-9][0-9]*)$/.test(numerator) && /^[1-9][0-9]*$/.test(denominator), 'rational');
  check(); const result = fromWire({ numerator, denominator }); check();
  requireThat(result.n.toString() === numerator && result.d.toString() === denominator, 'rational_canonical');
  requireThat(Number.isFinite(toNumber(result)), 'rational_range');
  return result;
}
function bound(value: unknown, maximum: number): asserts value is Bound {
  object(value, ['estimate', 'lower', 'upper']);
  const lower = value['lower'], estimate = value['estimate'], upper = value['upper'];
  finite(lower, 0, maximum); finite(estimate, lower, maximum); finite(upper, estimate, maximum);
}
/** Each regret statistic lives on [0,1], including when FULL source L1 is 2. */
export function assertBatchSourceWidth(value:Bound,sourceL1Upper:number):void {
  const slack=Math.min(1,down(sourceL1Upper+ENDPOINT_PRUNE_BUDGET));
  requireThat(slack===1 ? value.lower===0 && value.upper===1 : up(value.upper-value.lower)>=slack,'batch_source_error');
}
function sameBound(a: Bound, b: Bound): boolean { return a.estimate === b.estimate && a.lower === b.lower && a.upper === b.upper; }
function containsExact(actual: Bound, expected: Q): void {
  requireThat(cmp(fromBinary64(actual.lower), expected) <= 0 && cmp(fromBinary64(actual.upper), expected) >= 0, 'exact_interval');
}
function sameValue(a: ApproxValue, b: ApproxValue): boolean {
  return sameBound(a.p, b.p) && sameBound(a.b, b.b) && sameBound(a.c, b.c) &&
    a.consumed.every((part, k) => sameBound(part, b.consumed[k]!));
}
function outwardMaximum(value: number): number { for (let i = 0; i < 16; i++) value = up(value); return value; }
function valueShape(value: ApproxValue, ranges: readonly number[], prices: [Q, Q, Q]): void {
  object(value, ['p', 'b', 'c', 'consumed']); array(value.consumed, 3, 3);
  bound(value.p, 1); bound(value.b, outwardMaximum(ranges[1]!)); bound(value.c, outwardMaximum(ranges[2]!));
  value.consumed.forEach((part, k) => bound(part, ranges[k + 3]!));
  const algebra = makeApproxValue(value.p, value.consumed, prices, value.c, value.b);
  requireThat(value.c.estimate === algebra.c.estimate && value.b.estimate === algebra.b.estimate, 'consumption_algebra');
  // Independent B/C certificates may intersect the interval sums. They must
  // still enclose the algebraic centre and intersect both exact-price sums.
  requireThat(sameBound(value.c, algebra.c) && sameBound(value.b, algebra.b), 'consumption_interval');
}
function objective(value: ExactObjective, check: () => void): [Q, Q, Q] {
  object(value, ['p', 'b', 'c']); return [wire(value.p, check), wire(value.b, check), wire(value.c, check)];
}

type SourceProof={lower:Triple;upper:Triple;constant:boolean};
function sourceProof(plan:JointSourcePlan,day:number):SourceProof {
  const date=plan.dates[day];requireThat(date,'plan_day');
  return {lower:date.minUnits,upper:date.maxUnits,constant:date.minUnits.every((n,k)=>n===date.maxUnits[k])};
}
function validateCurrent(current: CertifiedCurrent, input: ServiceH14Input, sid: number, prices: [Q, Q, Q],
  check: () => void): { objective: [Q, Q, Q]; colours: [Q, Q, Q] } {
  object(current, ['status', 'value', 'kit', 'optimalActionMask', 'uses', 'pieces', 'certification']);
  requireThat(['use_certified', 'preserve', 'complete'].includes(current.status) &&
    current.certification === 'exact_rational_finite_inventory_v1', 'current_status');
  integer(current.optimalActionMask, 0, 7); integer(current.uses, 0, input.batchLimit ?? 10);
  requireThat(current.pieces === current.uses * 10, 'current_pieces');
  const terminal = sid === TERMINAL;
  requireThat((current.status === 'complete') === terminal, 'current_terminal');
  if (current.status === 'use_certified') {
    const k = ['blue', 'purple', 'yellow'].indexOf(current.kit ?? '');
    requireThat(k >= 0 && (current.optimalActionMask & (1 << k)) !== 0 && current.uses > 0 &&
      current.pieces <= input.stock[k]!, 'current_action');
  } else requireThat(current.kit === null && current.optimalActionMask === 0 && current.uses === 0, 'current_action');
  for (let k = 0; k < 3; k++) requireThat(!(current.optimalActionMask & (1 << k)) || input.stock[k]! >= 10, 'current_inventory');
  const value = current.value;
  object(value, ['successP', 'weightedExpectedConsumptionB', 'expectedTotalConsumptionC', 'expectedConsumed', 'display']);
  object(value.display, ['successP', 'weightedExpectedConsumptionB', 'expectedTotalConsumptionC']);
  array(value.expectedConsumed, 3, 3);
  const exact: [Q, Q, Q] = [wire(value.successP, check), wire(value.weightedExpectedConsumptionB, check), wire(value.expectedTotalConsumptionC, check)];
  const colours = value.expectedConsumed.map(part => wire(part, check)) as [Q, Q, Q];
  requireThat(cmp(exact[0], q(1)) <= 0, 'current_probability');
  let b = q(0), c = q(0);
  for (let k = 0; k < 3; k++) {
    requireThat(cmp(colours[k]!, q(10 * Math.min(CAPS[sid as StateId][k]!, Math.floor(input.stock[k]! / 10)))) <= 0, 'current_consumption');
    b = add(b, mul(prices[k]!, colours[k]!)); c = add(c, colours[k]!);
  }
  requireThat(cmp(b, exact[1]) === 0 && cmp(c, exact[2]) === 0, 'current_algebra');
  requireThat(value.display.successP === toNumber(exact[0]) && value.display.weightedExpectedConsumptionB === toNumber(exact[1]) &&
    value.display.expectedTotalConsumptionC === toNumber(exact[2]), 'current_display');
  if (current.status === 'use_certified') {
    const kit = ['blue', 'purple', 'yellow'].indexOf(current.kit!);
    requireThat(exact[0].n > 0n && cmp(colours[kit]!, q(10)) >= 0, 'current_first_consumption');
  }
  if (terminal || current.status === 'preserve') requireThat(exact[0].n === (terminal ? exact[0].d : 0n) && c.n === 0n, 'current_stopped_value');
  return { objective: exact, colours };
}

function validateDates(output: ServiceH14Output, input: ServiceH14Input, sid: number, prices: [Q, Q, Q],
  ranges: readonly number[], plan: JointSourcePlan, priors: readonly Q[], check: () => void): SourceProof[] {
  array(output.records, 15);
  if (output.current === null) { requireThat(output.records.length === 0, 'missing_current'); return []; }
  const current = validateCurrent(output.current, input, sid, prices, check);
  const proofs: SourceProof[] = [];
  for (let day = 0; day < output.records.length; day++) {
    check(); const record = output.records[day]!;
    object(record, ['day', 'value', 'risk', 'prefixKey', 'equalityKey'], ['exactObjective','objectiveProof','strictBurdenProof','positiveZeroKitWitness','batchEvidence']);
    requireThat(record.day === day, 'date_sequence'); text(record.prefixKey, 1024); nullableText(record.equalityKey);
    requireThat(record.prefixKey === plan.dates[day]?.prefixKey,'prefix_key');
    requireThat((record.batchEvidence!==undefined)===(day>0 && output.current.status==='use_certified'),'batch_scope');
    if(record.batchEvidence){
      const b=record.batchEvidence;
      object(b,['thresholdTicks','day','prefixKey','kit','uses','mean','mass']);
      requireThat(b.thresholdTicks===plan.dates[day]!.thresholdTicks,'batch_threshold');
      requireThat(b.day===day && b.prefixKey===record.prefixKey,'batch_date');
      requireThat(b.kit===output.current.kit && b.uses===output.current.uses,'batch_action');
      bound(b.mean,1);bound(b.mass,1);
      for(const v of [b.mean,b.mass])assertBatchSourceWidth(v,plan.dates[day]!.sourceL1Upper);
    }
    valueShape(record.value, ranges, prices);
    if(record.batchEvidence){
      const {mean,mass}=record.batchEvidence,h=q(record.batchEvidence.thresholdTicks,10000);
      // After the fixed exact Current batch, having more supplies cannot
      // lower success below D0's optimum. Also h*m <= E[r] <= h+(1-h)*m.
      requireThat(cmp(fromBinary64(mean.lower),sub(fromBinary64(record.value.p.upper),current.objective[0]))<=0 &&
        cmp(mul(h,fromBinary64(mass.lower)),fromBinary64(mean.upper))<=0 &&
        cmp(fromBinary64(mean.lower),add(h,mul(sub(q(1),h),fromBinary64(mass.upper))))<=0,'batch_consistency');
    }
    object(record.risk, ['meanSuccessP', 'insufficientGainMass', 'noFurtherWaitCertifiedMass', 'renewedWaitUpperBound']);
    for (const part of Object.values(record.risk)) bound(part, 1);
    requireThat(sameBound(record.risk.meanSuccessP, record.value.p), 'risk_mean');
    const renewed = complementBound(record.risk.noFurtherWaitCertifiedMass);
    requireThat(record.risk.renewedWaitUpperBound.estimate === renewed.estimate, 'risk_complement');
    // Exact Current risk masses legitimately omit outward rounding of 0/1.
    containsExact(record.risk.renewedWaitUpperBound, fromBinary64(1 - record.risk.noFurtherWaitCertifiedMass.estimate));
    requireThat(record.risk.renewedWaitUpperBound.lower <= 1 - record.risk.noFurtherWaitCertifiedMass.upper &&
      record.risk.renewedWaitUpperBound.upper >= 1 - record.risk.noFurtherWaitCertifiedMass.lower, 'risk_complement');
    const proof = sourceProof(plan,day); proofs.push(proof);
    requireThat(record.equalityKey === null || (day > 0 && proof.constant && record.equalityKey === 'point:'+sid+':'+proof.lower.join(',')),'equality_proof');
    if(record.positiveZeroKitWitness!==undefined){
      const witness=record.positiveZeroKitWitness;
      object(witness,['cohort']);integer(witness.cohort,0,plan.cohortCount-1);
      requireThat(day>0&&sid!==TERMINAL&&priors[witness.cohort]!.n>0n,'zero_kit_scope');
      // This is the consumer's independently sealed/certified source plan,
      // not a producer row, marginal minimum, or producer-supplied plan.
      requireThat(plan.dates[day]!.positiveZeroKitCohort===witness.cohort,'zero_kit_reachability');
      requireThat(record.strictBurdenProof===undefined&&record.objectiveProof===undefined,'zero_kit_conflicting_proof');
      if(record.exactObjective!==undefined){
        const p=wire(record.exactObjective.p,check);
        requireThat(p.n<p.d,'zero_kit_exact_probability');
      }
    }
    if (day > 0 && proof.constant) requireThat(record.exactObjective !== undefined,'root_evidence_required');
    if(record.objectiveProof!==undefined){
      const corners=record.objectiveProof;
      requireThat(day>0&&!proof.constant&&record.exactObjective!==undefined,'corner_proof_scope');
      object(corners,['kind','lower','upper']);requireThat(corners.kind==='full-support-corners','corner_proof_kind');
      const expectedObjective=objective(record.exactObjective!,check);
      for(const side of ['lower','upper'] as const){
        object(corners[side],['units','objective']);array(corners[side].units,3,3);
        requireThat(corners[side].units.every((n,k)=>n===proof[side][k]),'corner_full_support');
        const actualObjective=objective(corners[side].objective,check);
        requireThat(actualObjective.every((n,k)=>cmp(n,expectedObjective[k]!)===0),'corner_objective_equality');
      }
      requireThat(cmp(expectedObjective[0],q(1))===0,'corner_probability');
    }
    if(record.strictBurdenProof!==undefined){
      const strict=record.strictBurdenProof;
      requireThat(day>0&&!proof.constant&&record.exactObjective===undefined,'strict_burden_scope');
      object(strict,['lower','upper','witness']);
      object(strict.lower,['units','p'],['cover']);object(strict.upper,['units','objective']);
      for(const side of ['lower','upper'] as const){
        array(strict[side].units,3,3);
        requireThat(strict[side].units.every((n,k)=>n===proof[side][k]),'strict_burden_support');
      }
      bound(strict.lower.p,1);
      if(strict.lower.cover!==undefined){
        const expected=positiveSupportCover(plan,day,check);
        requireThat(expected!==undefined,'strict_burden_cover_unavailable');
        array(strict.lower.cover,expected!.length,expected!.length);
        for(let i=0;i<expected!.length;i++){
          const point=strict.lower.cover[i]!;
          object(point,['units','p']);array(point.units,3,3);bound(point.p,1);
          requireThat(point.units.every((n,k)=>n===expected![i]![k])&&point.p.lower===1,'strict_burden_cover');
        }
      }else requireThat(strict.lower.p.lower===1,'strict_burden_probability');
      const baseline=objective(strict.upper.objective,check);
      requireThat(cmp(baseline[0],q(1))===0,'strict_burden_probability');
      containsExact(record.value.p,q(1));
      const witness=strict.witness;
      object(witness,['cohort','coordinate','units','consumed'],['exactObjective']);
      integer(witness.cohort,0,plan.cohortCount-1);
      requireThat(priors[witness.cohort]!.n>0n,'strict_burden_prior');
      integer(witness.coordinate,0,2);
      const support=plan.dates[day]!.cohorts[witness.cohort]!;
      array(witness.units,3,3);array(witness.consumed,3,3);
      let burdenLower=q(0);
      for(let k=0;k<3;k++){
        const expected=k===witness.coordinate?support.minUnits[k]!:proof.upper[k]!;
        requireThat(witness.units[k]===expected,'strict_burden_face');
        bound(witness.consumed[k],10*witness.units[k]!);
        burdenLower=add(burdenLower,mul(prices[k]!,fromBinary64(witness.consumed[k]!.lower)));
      }
      if(witness.exactObjective){
        const face=objective(witness.exactObjective,check);
        requireThat(cmp(face[0],q(1))===0,'strict_burden_face_probability');
        const enclosed=makeApproxValue({estimate:1,lower:1,upper:1},witness.consumed,prices);
        containsExact(enclosed.b,face[1]);containsExact(enclosed.c,face[2]);
        requireThat(cmp(face[1],baseline[1])>0,'strict_burden_witness');
      }else requireThat(cmp(burdenLower,baseline[1])>0,'strict_burden_witness');
      requireThat(cmp(fromBinary64(record.value.b.upper),baseline[1])>0,'strict_burden_interval');
    }
    if (record.exactObjective !== undefined) {
      requireThat(day === 0 || proof.constant || record.objectiveProof!==undefined, 'unproved_exact_objective');
      const exact = objective(record.exactObjective, check);
      [record.value.p, record.value.b, record.value.c].forEach((part, k) => containsExact(part, exact[k]!));
      if (day === 0) requireThat(exact.every((part, k) => cmp(part, current.objective[k]!) === 0), 'current_objective');
    }
    if (day === 0) {
      requireThat(record.exactObjective !== undefined, 'current_objective');
      const p = rationalBound(current.objective[0]), colours = current.colours.map(rationalBound) as BoundTriple;
      const expected = makeApproxValue(p, colours, prices, rationalBound(current.objective[2]), rationalBound(current.objective[1]));
      requireThat(sameValue(record.value, expected), 'current_d0');
      const certified = cmp(current.objective[0], q(397, 400)) >= 0 ? 1 : 0;
      requireThat(sameBound(record.risk.insufficientGainMass, { estimate: 1, lower: 1, upper: 1 }) &&
        sameBound(record.risk.noFurtherWaitCertifiedMass, { estimate: certified, lower: certified, upper: certified }) &&
        sameBound(record.risk.renewedWaitUpperBound, { estimate: 1 - certified, lower: 1 - certified, upper: 1 - certified }), 'current_risk');
    }
  }
  return proofs;
}


function validateCertificate(output:ServiceH14Output,admission:ServiceH14Admission,proofs:readonly SourceProof[],budget:Budget):void {
  if(!output.records.length){requireThat(output.certificate===undefined&&output.sourceCertificate===undefined,'empty_certificate');return;}
  assertJointSourceCertificate(output.sourceCertificate,admission.plan,output.records.length-1,budget);
  const certificate=output.certificate;requireThat(certificate,'missing_certificate');
  object(certificate,['kind','sourceL1UpperByDay','endpointPruningBudget','endpointRelativeBound']);
  requireThat(certificate.kind==='deterministic'&&certificate.endpointPruningBudget===ENDPOINT_PRUNE_BUDGET&&certificate.endpointRelativeBound===2e-13,'deterministic_contract');
  array(certificate.sourceL1UpperByDay,15,output.records.length);
  for(let day=0;day<output.records.length;day++){
    budget.check();
    const actual=certificate.sourceL1UpperByDay[day]!,expected=admission.plan.dates[day]!.sourceL1Upper;
    requireThat(actual===expected,'source_full_l1');
    if(day===0||proofs[day]!.constant)continue;
    const error=Math.min(1,down(expected+ENDPOINT_PRUNE_BUDGET)),record=output.records[day]!,proof=proofs[day]!;
    const checkSpan=(value:Bound,range:number)=>requireThat(up(value.upper-value.lower)>=Math.max(0,down(error*range)),'source_error_underreported');
    checkSpan(record.value.p,1);
    record.value.consumed.forEach((part,k)=>checkSpan(part,proof.upper[k]!*10));
    checkSpan(record.risk.insufficientGainMass,1);checkSpan(record.risk.noFurtherWaitCertifiedMass,1);
  }
}

/** The independently trusted local admission, not request-supplied plans, is the consumer authority.
 * Numerical recurrence is owned by the verified native Worker; it is not re-executed on the UI thread. */
export function assertServiceH14Output(output:ServiceH14Output,request:ServiceH14Request,admission:ServiceH14Admission,mode:'current'|'final',budget:Budget):void {
  let reserved=0,external=0;
  const check=()=>{budget.check();if(Date.now()>=request.deadlineAt)throw new ServiceH14DeadlineError('service_h14_binding_original_deadline');};
  const reserve=(bytes:number)=>{
    integer(bytes,0,Number.MAX_SAFE_INTEGER);
    reserved+=bytes;
    budget.reserve(bytes);
    if(reserved>RUNTIME_BYTES)throw new ServiceH14AuditBudgetError();
  };
  try{
    check();reserve(VALIDATION_BYTES);
    object(request,['type','id','generation','sessionId','input','inputSha256','forecastIdentity','profile','deadlineAt'],['portableTollReady']);
    requireThat(!Object.hasOwn(request,'portableTollReady')||request.portableTollReady===true,'portable_offer');
    requireThat(request.type==='calculate','request');integer(request.id,1,Number.MAX_SAFE_INTEGER);integer(request.generation,1,Number.MAX_SAFE_INTEGER);text(request.sessionId,256);
    finite(request.deadlineAt);assertServiceH14Profile(request.profile);
    requireThat(request.inputSha256===admission.inputSha256&&sameCertifiedForecastIdentity(assertCertifiedForecastIdentity(request.forecastIdentity),admission.forecastIdentity),'admitted_request');
    const legacyD0 = admission.legacyLeaseUntil !== undefined;
    requireThat(legacyD0 === (request.input.legacyD0 !== undefined),'legacy_d0_mode');
    scanServiceJson(output,check,2*1024*1024);
    object(output,['schemaVersion','numericalContract','profile','inputSha256','forecastIdentity','request','current','pricingWeights','status','elapsedMs','records','accuracy','decision','diagnostics','reason'],['certificate','sourceCertificate','adaptive','prefixDecision']);
    requireThat(output.schemaVersion===1&&output.numericalContract==='bounded-error-h14-v1','contract');
    object(output.profile,Object.keys(SERVICE_H14_PROFILE));assertServiceH14Profile(output.profile);
    requireThat(output.inputSha256===admission.inputSha256&&sameCertifiedForecastIdentity(assertCertifiedForecastIdentity(output.forecastIdentity),admission.forecastIdentity),'output_identity');
    object(output.request,['id','generation','sessionId']);
    requireThat(output.request.id===request.id&&output.request.generation===request.generation&&output.request.sessionId===request.sessionId,'request_identity');
    requireThat(['complete','incomplete','withheld','claim_required','error'].includes(output.status),'status');
    finite(output.elapsedMs,0,serviceH14DeadlineMs(request.input));nullableText(output.reason);
    requireThat(output.reason !== 'legacy_current_only' || (legacyD0 && output.status === 'withheld'), 'legacy_d0_authority');
    object(output.accuracy,['kind','confidence','practical','strict','maxProbabilityWidth','maxPieceWidth','maxRiskWidth']);
    requireThat(output.accuracy.kind==='deterministic-bound'&&output.accuracy.confidence===null,'accuracy_kind');
    object(output.decision,['status','day']);
    if(legacyD0) {
      requireThat(mode==='final' && request.input.computeWaiting===false && request.input.computeMinimumWait===false,'legacy_d0_scope');
      array(output.records,1,output.current ? 1 : 0);
      requireThat(!output.records[0]?.batchEvidence && output.decision.status==='unavailable' && output.decision.day===null,'legacy_d0_decision');
    }
    object(output.diagnostics,[],Object.keys(output.diagnostics));
    for(const value of Object.values(output.diagnostics))requireThat(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)),'diagnostic_value');
    const priors=validate(request.input,check);
    const pricingBudget={check,setExternalPayload(bytes:number){integer(bytes,0,RUNTIME_BYTES);if(bytes>external){reserve(bytes-external);external=bytes;}check();}} as WorkBudget;
    const prices=[...calculatePricing(request.input,priors,pricingBudget).weights] as [Q,Q,Q];
    if(output.pricingWeights===null)requireThat(output.current===null&&output.records.length===0&&(output.status==='error'||output.status==='incomplete'),'missing_pricing');
    else{array(output.pricingWeights,3,3);output.pricingWeights.forEach((part,k)=>requireThat(cmp(wire(part,check),prices[k]!)===0,'fixed_price'));}
    const sid=encode(request.input.grade,request.input.level,request.input.exp),colours=admission.plan.maxUnits.map(n=>10*n);
    let burden=0;for(let k=0;k<3;k++)burden=up(burden+up(rationalBound(prices[k]!).upper*colours[k]!));
    const ranges=[1,burden,colours.reduce((a,b)=>a+b,0),...colours];
    if(output.records.length>1){
      // During a prefix audit the pricing/JSON traversal is finished and its
      // scratch is idle. The price-law cache, small retained state and output
      // remain charged. Do not double-reserve idle scratch alongside spectral
      // workspace; restore it before decoding date proofs and adaptive bounds.
      const reuse=output.status==='incomplete'&&isCertifiedPrefixStop(output.reason)&&!admission.plan.spectralCertified;
      if(reuse){reserved-=VALIDATION_SCRATCH;budget.release(VALIDATION_SCRATCH);}
      certifyJointSourcePlan(admission.plan,admission.priors,{check,reserve,release(bytes){reserved-=bytes;budget.release(bytes);}});
      if(reuse)reserve(VALIDATION_SCRATCH);
    }
    const proofs=validateDates(output,request.input,sid,prices,ranges,admission.plan,admission.priors,check);
    validateCertificate(output,admission,proofs,{check,reserve,release(bytes){reserved-=bytes;budget.release(bytes);}});
    const accuracy=assessAccuracy(output.records,prices,'deterministic-bound',null);
    for(const key of Object.keys(accuracy) as (keyof typeof accuracy)[])requireThat(output.accuracy[key]===accuracy[key],'accuracy');
    const received=new Set(request.input.receivedEventIds??[]);
    const claim=admission.conditionalUntil===undefined&&request.input.snapshot.events.some(event=>{check();return isCertifiedEventClaimable(request.input.snapshot,event,request.input.asOf)&&!received.has(event.id);});
    const conditional=admission.conditionalUntil!==undefined;
    requireThat(conditional===(request.input.previewJoint!==undefined),'conditional_scope');
    const healthy=conditional||request.input.snapshot.sourceStatus==='healthy'&&request.input.snapshot.warnings.length===0;
    const coverage=conditional||request.input.snapshot.coverage.future.complete;
    const resource=isServiceH14ResourceReason(output.reason);
    if(resource && output.records.length)requireThat(!claim&&!legacyD0&&healthy&&output.status==='incomplete'&&
      (output.records.length===1||(coverage&&request.input.computeWaiting!==false)),'resource_scope');
    if(resource && output.current)requireThat(output.records.length>0,'resource_missing_d0');
    requireThat(!(output.status==='error'&&resource),'resource_status');
    if(output.status!=='error'&&output.current!==null){
      if(claim)requireThat(output.status==='claim_required','claim_gate');
      else if(legacyD0)requireThat(output.status==='withheld' && output.reason==='legacy_current_only','legacy_d0_gate');
      else if(!healthy)requireThat(output.status==='withheld','health_gate');
      else requireThat(output.status!=='claim_required'&&output.status!=='withheld','unexpected_gate');
    }
    const ready=mode==='final'&&!claim&&healthy&&coverage&&request.input.computeWaiting!==false&&output.status!=='error'&&!resource&&accuracy.practical&&output.records.length===15;
    const expected=ready?batchDecision(output.records):{status:'unavailable',day:null};
    requireThat(output.decision.status===expected.status&&output.decision.day===expected.day,'batch_decision');
    requireThat((output.status==='complete')===ready,'completion');
    if(ready)requireThat(output.reason===null,'complete_reason');
    const portable=output.diagnostics['portableToll']===true;
    requireThat(!Object.hasOwn(output.diagnostics,'portableToll')||(portable&&ready&&request.portableTollReady===true&&!!admission.portableToll),'portable_scope');
    const decisionBudget={check,reserve,release(bytes:number){reserved-=bytes;budget.release(bytes);}};
    const full=ready?adaptiveDecision(request.input,admission,output,decisionBudget,portable):undefined;
    requireThat(Object.hasOwn(output,'adaptive')===(full!==undefined),'adaptive_scope');
    let prefix:ServiceH14Output['prefixDecision'];
    if(Object.hasOwn(output,'prefixDecision')){
      requireThat(mode==='final'&&!claim&&!legacyD0&&healthy&&coverage&&request.input.computeWaiting!==false&&
        output.status==='incomplete'&&isCertifiedPrefixStop(output.reason),'prefix_decision_scope');
      const actual=output.prefixDecision;
      object(actual,['horizon','verdict']);
      requireThat(actual.horizon===output.records.length-1&&actual.horizon>0&&actual.horizon<14,'prefix_decision_horizon');
      try{
        prefix=adaptivePrefixDecision(request.input,admission,output,{...decisionBudget,check(){check();budget.checkPrefixTime?.();}});
      }catch(error){
        if(error instanceof ServiceH14AuditBudgetError)throw new ServiceH14PrefixBudgetError();
        throw error;
      }
      requireThat(prefix,'prefix_decision_scope');
    }
    const adaptive=full??prefix?.verdict;
    if(adaptive){
      const actual=full?output.adaptive:output.prefixDecision?.verdict;requireThat(actual,'adaptive_missing');
      object(actual,['mathematical','actionable','firstKit','practicalFirstKit','practicalBatchUses','nextDay','nextAt','delta']);object(actual.delta,['lower','upper']);
      requireThat(actual.mathematical===adaptive.mathematical&&actual.actionable===adaptive.actionable&&actual.firstKit===adaptive.firstKit&&actual.practicalFirstKit===adaptive.practicalFirstKit&&actual.practicalBatchUses===adaptive.practicalBatchUses&&actual.nextDay===adaptive.nextDay&&actual.nextAt===adaptive.nextAt&&actual.delta.lower===adaptive.delta.lower&&actual.delta.upper===adaptive.delta.upper,'adaptive_decision');
    }
    if(mode==='current')requireThat(output.records.length===1&&output.current!==null&&output.status==='incomplete'&&!claim&&healthy,'current_mode');
    // Both realms admitted the signed input. Audit the result for that request,
    // not a later head or clock; the original compute deadline still applies.
    check();
  }finally{if(reserved)budget.release(reserved);}
}
