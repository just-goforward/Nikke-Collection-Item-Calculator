import type { CertifiedOutput } from "../certified/types.ts";

export function interruptedCertifiedWaiting<O extends CertifiedOutput>(
  partial: O,
  interruption: "aborted" | "deadline" | "worker",
): O {
  const output = structuredClone(partial);
  let reason = "worker_execution_failure";
  if (interruption === "deadline") {
    reason = "worker_total_deadline";
  } else if (interruption === "aborted") {
    reason = "worker_abort";
  }
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
