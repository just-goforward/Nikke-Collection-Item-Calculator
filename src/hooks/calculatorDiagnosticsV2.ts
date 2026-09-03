import {
  SOLVER_RECOVERY_APP_REVISION_PATTERN,
  SOLVER_RECOVERY_SOLVER_VERSIONS,
} from "../../shared/solverRecoveryContract";
import { makeSolverRecoveryEvent } from "./calculatorDiagnostics";
import type { SolveOutcome } from "./calculatorShared";
import type { SolverRecoveryTrace } from "./solverRecoveryPolicy";

export function makeSolverRecoveryEventV2(
  input: SolveOutcome["result"]["input"],
  trace: SolverRecoveryTrace | undefined,
) {
  const event = makeSolverRecoveryEvent(input, trace);
  if (!event) return null;
  const revision = typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : "unknown";
  return {
    ...event,
    recoveryVersion: 2 as const,
    appRevision: SOLVER_RECOVERY_APP_REVISION_PATTERN.test(revision) ? revision : "unknown",
    solverVersions: SOLVER_RECOVERY_SOLVER_VERSIONS,
  };
}
