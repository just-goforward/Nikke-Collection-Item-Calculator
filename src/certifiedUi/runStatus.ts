import type { CertifiedOutput } from "../certified/types";
import { CertifiedRuntimeError } from "../certifiedRuntime/client";
import { type CertifiedVisibilityAbortContext, isCertifiedVisibilityAbort } from "./runVisibility";

const capacityReasons = new Set([
  "request_budget_exhausted",
  "managed_payload_ceiling",
  "exact_support_limit",
  "exact_memo_limit",
]);

export function certifiedRunError(
  failure: unknown,
  background?: CertifiedVisibilityAbortContext,
): "limit" | "error" | "background" {
  if (
    isCertifiedVisibilityAbort(background) &&
    (failure === background?.cause ||
      (failure instanceof CertifiedRuntimeError && failure.code === "aborted"))
  )
    return "background";
  if (
    failure instanceof CertifiedRuntimeError &&
    (failure.code === "deadline" || failure.code === "memory")
  )
    return "limit";
  return failure instanceof Error && failure.message === "certified_total_deadline"
    ? "limit"
    : "error";
}

export function certifiedSilentCancellation(
  failure: unknown,
  signal: AbortSignal,
  kind: ReturnType<typeof certifiedRunError>,
) {
  if (kind === "background") return false;
  return (
    (signal.aborted && failure === signal.reason) ||
    (failure instanceof CertifiedRuntimeError &&
      (failure.code === "superseded" || failure.code === "aborted"))
  );
}

export function certifiedBackgroundPartial(
  output: CertifiedOutput,
  background: CertifiedVisibilityAbortContext,
) {
  return (
    isCertifiedVisibilityAbort(background) &&
    output.status === "partial" &&
    output.current !== null &&
    output.refusal?.phase === "waiting" &&
    output.refusal.reason === "worker_abort" &&
    output.waiting.reason === "worker_abort"
  );
}

export function showCertifiedRunResults(
  error: false | ReturnType<typeof certifiedRunError>,
  output: CertifiedOutput | null,
) {
  return !error || (error === "background" && Boolean(output?.current));
}

export function certifiedCurrentRefusal(output: CertifiedOutput | null): "limit" | "error" | null {
  if (!output?.refusal || output.current) return null;
  return capacityReasons.has(output.refusal.reason) ? "limit" : "error";
}
