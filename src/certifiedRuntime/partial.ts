import type { CertifiedOutput } from "../certified/types.ts";

export function interruptedCertifiedWaiting<O extends CertifiedOutput>(
  partial: O,
  interruption: "aborted" | "deadline" | "worker",
): O {
  const output = structuredClone(partial);
  const reason =
    interruption === "deadline"
      ? "worker_total_deadline"
      : interruption === "aborted"
        ? "worker_abort"
        : "worker_execution_failure";
  output.status = "partial";
  output.waiting = {
    ...output.waiting,
    status: "unresolved",
    recommendedDays: null,
    rangeBoundary: false,
    reason,
    evidence: [...output.waiting.evidence, "exact_current_retained_after_waiting_interruption"],
  };
  output.refusal = { phase: "waiting", reason };
  return output;
}
