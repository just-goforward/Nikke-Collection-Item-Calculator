export type ObserverCanaryRow = {
  canary_id: string;
  deployment_sha: string;
  started_at: string;
  ends_at: string;
  status: "running" | "passed" | "failed";
};

export type ObserverCanaryRunRow = {
  scheduled_at: string;
  status: "running" | "completed" | "failure";
  deployment_sha: string;
  duplicate_attempts: number;
};

export function evaluateObserverCanary(input: {
  canary: ObserverCanaryRow;
  runs: ObserverCanaryRunRow[];
  unsentAlerts: number;
  contractRejections: number;
  nowMs: number;
}) {
  const startMs = Date.parse(input.canary.started_at);
  const endMs = Date.parse(input.canary.ends_at);
  if (
    !/^soc-[0-9a-f]{32}$/.test(input.canary.canary_id) ||
    !/^[0-9a-f]{40}$/.test(input.canary.deployment_sha) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs - startMs !== 8 * 60 * 60_000
  ) {
    throw new Error("invalid_observer_canary_contract");
  }

  const expected = expectedObserverSlots(startMs, endMs);
  const expectedSet = new Set(expected);
  const observed = new Set<string>();
  let completed = 0;
  let failed = 0;
  let running = 0;
  let duplicateAttempts = 0;
  let wrongDeployment = 0;
  let unexpectedSlots = 0;

  for (const run of input.runs) {
    const slot = minuteSlot(run.scheduled_at);
    if (!slot || !expectedSet.has(slot)) unexpectedSlots += 1;
    else observed.add(slot);
    if (run.status === "completed") completed += 1;
    else if (run.status === "failure") failed += 1;
    else running += 1;
    duplicateAttempts += nonnegativeInteger(run.duplicate_attempts);
    if (run.deployment_sha !== input.canary.deployment_sha) wrongDeployment += 1;
  }

  const eligible = input.nowMs >= endMs;
  const statusEligible = input.canary.status !== "failed";
  const missingSlots = expected.length - observed.size;
  const passed =
    eligible &&
    statusEligible &&
    expected.length === 16 &&
    missingSlots === 0 &&
    completed === expected.length &&
    failed === 0 &&
    running === 0 &&
    duplicateAttempts === 0 &&
    wrongDeployment === 0 &&
    unexpectedSlots === 0 &&
    input.unsentAlerts === 0 &&
    input.contractRejections === 0;

  return {
    version: 1 as const,
    canaryId: input.canary.canary_id,
    deploymentSha: input.canary.deployment_sha,
    window: {
      startedAt: input.canary.started_at,
      endsAt: input.canary.ends_at,
      eligible,
      statusEligible,
    },
    expectedSlots: expected.length,
    observedSlots: observed.size,
    missingSlots,
    completed,
    failed,
    running,
    duplicateAttempts,
    wrongDeployment,
    unexpectedSlots,
    unsentAlerts: input.unsentAlerts,
    contractRejections: input.contractRejections,
    passed,
  };
}

export function expectedObserverSlots(startMs: number, endMs: number) {
  const slots: string[] = [];
  let cursor = Math.floor(startMs / 60_000) * 60_000;
  if (cursor < startMs) cursor += 60_000;
  for (; cursor < endMs; cursor += 60_000) {
    const minute = new Date(cursor).getUTCMinutes();
    if (minute === 7 || minute === 37) slots.push(new Date(cursor).toISOString().slice(0, 16));
  }
  return slots;
}

function minuteSlot(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 16) : null;
}

function nonnegativeInteger(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("invalid_observer_run_count");
  return number;
}
