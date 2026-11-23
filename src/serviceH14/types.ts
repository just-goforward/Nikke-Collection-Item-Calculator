import type { Q, WireQ } from '../../shared/certifiedRational.ts';
import type { CertifiedInput, CertifiedCurrent, Triple } from '../certified/types.ts';
import type { ExactValue } from '../certified/value.ts';
import type { WorkBudget } from '../certified/budget.ts';
import type { CertifiedForecastIdentity } from '../../shared/certifiedForecastIdentity.ts';
import type { CertifiedSupplyLaw } from '../../shared/certifiedSupplyLaws.ts';
import type { CertifiedSupplyVersion } from '../../shared/certifiedSupplyModel.ts';
import type { CertifiedMemory } from '../certifiedRuntime/protocol.ts';
import type { PublicationBytes } from '../../shared/forecastPublicationBytes.ts';

export type ServiceH14Input = CertifiedInput & { priceParent?: string; legacyD0?: { timedOff: PublicationBytes }; previewJoint?: { timedOff: PublicationBytes | null } };
export type Bound = { estimate: number; lower: number; upper: number };
export type BoundTriple = [Bound, Bound, Bound];
export type ApproxValue = { p: Bound; b: Bound; c: Bound; consumed: BoundTriple };
export type ApproxRisk = { meanSuccessP: Bound; insufficientGainMass: Bound; noFurtherWaitCertifiedMass: Bound; renewedWaitUpperBound: Bound };
/** Only native exact root evidence (or exact Current), never rounded future values. */
export type ExactObjective = { p: WireQ; b: WireQ; c: WireQ };
export type CornerObjectiveProof = { kind: 'full-support-corners'; lower: { units: Triple; objective: ExactObjective }; upper: { units: Triple; objective: ExactObjective } };
/** Every full-support atom has P=1 and B >= upper.objective.b. A cohort
 * coordinate attains its marginal minimum with positive probability; its
 * upper-inventory face proves strictly larger burden on that subset. */
export type StrictBurdenProof = {
  lower: { units: Triple; p: Bound; cover?: { units: Triple; p: Bound }[] };
  upper: { units: Triple; objective: ExactObjective };
  witness: { cohort: number; coordinate: number; units: Triple; consumed: BoundTriple; exactObjective?: ExactObjective };
};
/** A positive-prior cohort has a physical prefix ending with zero usable kits.
 * Day and prefix identity are inherited from the containing date record. */
export type PositiveZeroKitWitness = { cohort: number };
export type BatchEvidence = { thresholdTicks: number; day: number; prefixKey: string; kit: NonNullable<CertifiedCurrent['kit']>; uses: number; mean: Bound; mass: Bound };
export type BatchDecision = { status: 'wait' | 'no_wait_basis' | 'unresolved' | 'no_action' | 'unavailable'; day: number | null };
export type ApproxDate = { batchEvidence?: BatchEvidence; day: number; value: ApproxValue; risk: ApproxRisk; prefixKey: string; equalityKey: string | null; exactObjective?: ExactObjective; objectiveProof?: CornerObjectiveProof; strictBurdenProof?: StrictBurdenProof; positiveZeroKitWitness?: PositiveZeroKitWitness };
export type AccuracyTargets = { probability: number; pieces: number; risk: number };
export const PRACTICAL_TARGETS: Readonly<AccuracyTargets> = Object.freeze({ probability: 1e-4, pieces: 0.1, risk: 1e-3 });
export const STRICT_TARGETS: Readonly<AccuracyTargets> = Object.freeze({ probability: 1e-6, pieces: 0.01, risk: 1e-4 });
export type ApproxAccuracy = { kind: 'deterministic-bound'; confidence: null; practical: boolean; strict: boolean; maxProbabilityWidth: number; maxPieceWidth: number; maxRiskWidth: number };
export type ApproxSelection = { status: 'COMPLETE' | 'INCOMPLETE'; day: number | null; value: ApproxValue | null; reason: string | null };
export type ApproxDiagnostics = { [key: string]: number | string | boolean | null };
export type ApproxDeterministicCertificate = { kind: 'deterministic'; sourceL1UpperByDay: number[]; endpointPruningBudget: number; endpointRelativeBound: number };
export type ApproxComputation = { records: ApproxDate[]; accuracy: ApproxAccuracy; decision: BatchDecision; diagnostics: ApproxDiagnostics; reason: string | null; certificate?: ApproxDeterministicCertificate; sourceCertificate?: JointSourceCertificate };
export type EndpointResult = { p: Bound; consumed: BoundTriple; mask: number; equalityKey: string | null; exactObjective?: ExactObjective };
export type EndpointSolver = { batchRegrets(units: readonly Triple[], day: number, kit: number, uses: number, thresholdTicks: number): {lower:number;upper:number;above:boolean|null}[]; solve(units: Triple): EndpointResult; compareProbability(units: Triple, threshold: Q): number; diagnostics(): ApproxDiagnostics; dispose(): void };
export type EndpointOptions = { sid: number; maxUnits: Triple; prices: [Q, Q, Q]; budget: WorkBudget; getExact: (sid: number, units: Triple) => ExactValue };
export type ApproxRunContext = { input: ServiceH14Input; sid: number; prices: [Q, Q, Q]; priors: Q[]; current: CertifiedCurrent; p0: Q; budget: WorkBudget; endpoints: EndpointSolver; plan: JointSourcePlan };

export type JointSourceDescriptor = { snapshotVersion: CertifiedSupplyVersion; dependence: 'independent-days-given-cohort'; cohortCount: 3 | 4; events: readonly { day: number; refs: readonly { lawId: string; count: number }[] }[]; laws: readonly CertifiedSupplyLaw[] };
export type JointCohortPlan = { rawMin: Triple; rawMax: Triple; rawOverflow: boolean; minUnits: Triple; maxUnits: Triple };
export type JointDatePlan = { thresholdTicks: number; day: number; prefixKey: string; cohorts: readonly JointCohortPlan[]; minUnits: Triple; maxUnits: Triple; window: Triple; sourceL1Upper: number; positiveZeroKitCohort?: number | null };
export type JointSourcePlan = { algorithm: 'joint-spectral-mixture-v3'; streamKind: 'prior-mixture'; sourceIdentity: string; sourceKey: string; projectionKey: string; snapshotVersion: CertifiedSupplyVersion; cohortCount: 3 | 4; sid: number; stock: Triple; pieceCaps: Triple; maxUnits: Triple; descriptor: JointSourceDescriptor; dates: readonly JointDatePlan[]; spectralCertified: boolean; hostPerformedWork: number; hostWork: { hostScalarOps: number; hostStateVisits: number; hostIntegerOps: number } };
export type JointSourceCertificate = { algorithm: 'joint-spectral-mixture-v3'; streamKind: 'prior-mixture'; normalization: 'subprobability'; sourceKey: string; projectionKey: string; cohortCount: 3 | 4; completedThrough: number; days: readonly { day: number; prefixKey: string; window: Triple; sourceL1Upper: number }[] };
export type UnitMass = { units: Triple; mass: number };
export type JointSourceEvent = { kind: 'init'; streamKind: 'prior-mixture' } | { kind: 'date_begin'; day: number } | { kind: 'mixture_begin'; day: number; rowCount: number } | { kind: 'rows'; day: number; rows: readonly UnitMass[] } | { kind: 'mixture_end'; day: number } | { kind: 'date_end'; day: number } | { kind: 'done' } | { kind: 'error'; reason: string; lastAckedDay: number };
export type JointSource = { read(consume: (event: JointSourceEvent) => void): 'event' | 'done'; ackDate(day: number): void; dispose(): void };

export type AdaptiveDecision = { mathematical:'wait'|'use_now'|'unresolved'; actionable:'wait'|'no_material_wait'|'unresolved'; firstKit:CertifiedCurrent['kit']; practicalFirstKit:CertifiedCurrent['kit']; practicalBatchUses:number; nextDay:number; nextAt:string; delta:{lower:number;upper:number} };
export type ServiceH14Profile = { id: 'service-fused-h14-v1'; environment: 'service-candidate'; policy: 'adaptive-next-batch-balanced-v1'; horizon: 14; codeHash: string; exactWasmHash: string; numericalContract: 'bounded-error-h14-v1' };
export type ServiceH14Request = { type: 'calculate'; id: number; generation: number; sessionId: string; input: ServiceH14Input; inputSha256: string; forecastIdentity: CertifiedForecastIdentity; profile: ServiceH14Profile; deadlineAt: number; portableTollReady?:true };
export type ServiceH14Output = ApproxComputation & { adaptive?:AdaptiveDecision; prefixDecision?:{horizon:number;verdict:AdaptiveDecision}; schemaVersion: 1; numericalContract: 'bounded-error-h14-v1'; profile: ServiceH14Profile; inputSha256: string; forecastIdentity: CertifiedForecastIdentity; request: { id: number; generation: number; sessionId: string }; current: CertifiedCurrent | null; pricingWeights: [WireQ, WireQ, WireQ] | null; status: 'complete' | 'incomplete' | 'withheld' | 'claim_required' | 'error'; elapsedMs: number };
export type ServiceH14WorkerMessage = { type: 'current' | 'result'; id: number; generation: number; sessionId: string; priceSeal?: string; prefixSeal?: string; output: ServiceH14Output };
export type ServiceH14Receipt = { outputMode: 'current' | 'result'; interruptionReason?: string; interruption: 'resource' | 'aborted' | 'deadline' | 'worker' | 'memory' | null; requestId: number; generation: number; sessionId: string; deadlineAt: number; timing: { totalMs: number; queuedMs: number; initAndBindingMs: number; computeAndValidationMs: number }; memory: CertifiedMemory; observerCallbackFailureCount: number };
export type ServiceH14ClientResult = { output: ServiceH14Output; receipt: ServiceH14Receipt };
export type ServiceH14RequestOptions = { sessionId: string; parentInputHash?: string; signal?: AbortSignal; totalDeadlineMs?: number; onCurrent?: (output: ServiceH14Output) => void };
