import { ServiceCertifiedCancelled, type ServiceCertifiedSolveOutcome } from "./serviceCertifiedTypes";

/** Two independent requests at most. A hidden/frozen interval must span the actual
 * cutoff; mere visibility changes, solver faults and bad publications never retry. */
export async function withPreviewResume(budget: number, signal: AbortSignal,
  solve: (retry: boolean, submitted: number, epoch: number) => Promise<ServiceCertifiedSolveOutcome>,
  submitted = performance.now(), epoch = Date.now()) {
  const elapsed = () => Math.max(performance.now() - submitted, Date.now() - epoch);
  let frozen = false, pausedBeforeCutoff = document.visibilityState === "hidden", crossed = false;
  let wake: (() => void) | undefined;
  const changed = () => {
    const time = elapsed();
    if (pausedBeforeCutoff && time >= budget) crossed = true;
    const paused = frozen || document.visibilityState === "hidden";
    pausedBeforeCutoff = paused && (pausedBeforeCutoff || time < budget);
    if (!paused) wake?.();
  };
  const freeze = () => { frozen = true; changed(); };
  const resume = () => { frozen = false; changed(); };
  const aborted = () => wake?.();
  document.addEventListener("visibilitychange", changed);
  document.addEventListener("freeze", freeze);
  document.addEventListener("resume", resume);
  signal.addEventListener("abort", aborted);
  try {
    try {
      const outcome = await solve(false, submitted, epoch);
      changed();
      if (!crossed || outcome.result.certified.interruption !== "deadline") return outcome;
    } catch (error) {
      changed();
      if (!crossed || !(error instanceof Error) || error.message !== "certified_total_deadline") throw error;
    }
    if (!signal.aborted && (frozen || document.visibilityState === "hidden"))
      await new Promise<void>(resolve => { wake = resolve; });
    if (signal.aborted) throw new ServiceCertifiedCancelled();
    return solve(true, performance.now(), Date.now());
  } finally {
    document.removeEventListener("visibilitychange", changed);
    document.removeEventListener("freeze", freeze);
    document.removeEventListener("resume", resume);
    signal.removeEventListener("abort", aborted);
  }
}
