import type { ServiceH14Output } from "../serviceH14/types";
import type { Kit, SolverInput } from "../types";
import type { PreviewTimedSupply } from "../ui-types";
import type { RecommendedRun, SolverResult } from "./calculatorShared";

/** Exact physical Current plus validated bounded H14 evidence, never a legacy result. */
export type ServiceCertifiedResult = {
  output: ServiceH14Output;
  final: boolean;
  userRequestedDecision?: true;
  /** Physical batch only; a failed replacement no longer owns the client's price parent. */
  retainedPhysical?: true;
  previewConditional?: true;
  previewLegacyD0?: true;
  previewTimedSupply?: PreviewTimedSupply | null;
  previewSourceStatus?: "healthy" | "uncertain";
  interruption?: string;
  interruptionReason?: string;
  followUp?: boolean;
  action: { kit: Kit; run: RecommendedRun } | null;
};

/** Only final physical batches can own a follow-up; a wait verdict is not its authority. */
export function physicalParentHash(parent: ServiceCertifiedResult | undefined): string | undefined {
  return parent?.final && parent.action && (parent.output.status === "complete" ||
    (parent.output.status === "incomplete" && parent.interruption))
    ? parent.output.inputSha256 : undefined;
}

export type ServiceCertifiedSolveOutcome = {
  kind: "service-certified";
  result: SolverResult & { input: SolverInput; certified: ServiceCertifiedResult };
};

export type ServiceCertifiedAdapter = {
  invalidateSolve(): void;
  checkForecastBoundary(): boolean;
  dispose(): Promise<void>;
  solveBestAvailable(
    source: SolverInput,
    onCurrent?: (result: SolverResult) => void,
    submitted?: number,
    parentInputHash?: string,
    submittedEpoch?: number,
  ): Promise<ServiceCertifiedSolveOutcome>;
};

export class PreviewSolverResourceError extends Error {
  constructor(readonly interruption: "memory" | "resource", reason: string) { super(reason); }
}

export class PreviewCalculationError extends Error {
  constructor(readonly kind: 'binding' | 'worker',
    readonly stage: 'physical-parent' | 'physical-child' | 'client-admission' | 'worker-admission' | 'client-audit' | 'compute' | 'worker-channel') {
    super(`service_h14_${kind}_failure`);
  }
}

export class ServiceCertifiedCancelled extends Error {
  constructor(readonly unmounted = false) {
    super("Service certified request no longer owns the displayed inputs.");
  }
}
