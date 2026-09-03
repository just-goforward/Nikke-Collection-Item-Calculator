export function assertWorkerRuntimeWindowPair(startedAt?: string, endedAt?: string) {
  if (Boolean(startedAt) !== Boolean(endedAt)) {
    throw new Error("cloudflare_paid_runtime_window_pair_required");
  }
}

export function resolveWorkerRuntimeWindow(
  input: { startedAt: string | undefined; endedAt: string | undefined },
  nowMs: number,
  periodStart: string,
  maximumWindowMs: number,
) {
  const endedAt = input.endedAt ?? new Date(nowMs).toISOString();
  const endedMs = Date.parse(endedAt);
  const startedAt =
    input.startedAt ??
    new Date(Math.max(Date.parse(periodStart), endedMs - maximumWindowMs)).toISOString();
  const startedMs = Date.parse(startedAt);
  if (
    !Number.isFinite(startedMs) ||
    !Number.isFinite(endedMs) ||
    startedMs >= endedMs ||
    endedMs > nowMs ||
    startedMs < Date.parse(periodStart) ||
    endedMs - startedMs > maximumWindowMs
  ) {
    throw new Error("cloudflare_paid_runtime_window_invalid");
  }
  return { runtimeStartedAt: startedAt, runtimeEndedAt: endedAt };
}
