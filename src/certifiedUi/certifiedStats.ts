import type { CertifiedBatch } from "./calculatorSessionActions";
import type { CertifiedSession } from "./session";

export function makeCertifiedKitResultEvent(
  batch: CertifiedBatch,
  next: CertifiedSession,
  successAttempt: number | null,
) {
  const before = batch.before;
  const stockBefore = { blue: before.stock[0], purple: before.stock[1], yellow: before.stock[2] };
  const stockAfter = { blue: next.stock[0], purple: next.stock[1], yellow: next.stock[2] };
  return {
    kind: "kit_result" as const,
    start: { grade: before.state.grade, level: before.state.level, exp: before.state.exp },
    kit: batch.kit,
    recommendedUses:
      successAttempt === null ? (stockBefore[batch.kit] - stockAfter[batch.kit]) / 10 : batch.uses,
    outcome: successAttempt === null ? ("no_great_success" as const) : ("great_success" as const),
    successAttempt,
    stockBefore,
    stockAfter,
    resultState: { grade: next.state.grade, level: next.state.level, exp: next.state.exp },
  };
}
