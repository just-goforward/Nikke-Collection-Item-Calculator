import type { CertifiedRuntimeOutput } from "../certifiedRuntime/outputBinding";
import type { Kit, SolverInput } from "../types";
import type { RecommendedRun, SolverResult } from "./calculatorShared";

/** Native certified evidence plus an action projection, never a legacy solver result. */
export type ServiceCertifiedResult = {
  output: CertifiedRuntimeOutput;
  final: boolean;
  action: { kit: Kit; run: RecommendedRun } | null;
};

export type ServiceCertifiedSolveOutcome = {
  kind: "service-certified";
  result: SolverResult & { input: SolverInput; certified: ServiceCertifiedResult };
};

export class ServiceCertifiedCancelled extends Error {
  constructor(readonly unmounted = false) {
    super("Service certified request no longer owns the displayed inputs.");
  }
}
