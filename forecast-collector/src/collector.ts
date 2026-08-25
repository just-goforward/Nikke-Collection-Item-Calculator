import { nextNaverRetryAt } from "./db";
import {
  finishInvocation,
  invocationCircuitState,
  pollNaverSource,
  sourcesForInvocation,
  startInvocation,
} from "./source-queue";
import type { CollectionSummary, CollectorEnv } from "./types";

export async function runCollection(
  env: CollectorEnv,
  options: { nowMs?: number } = {},
): Promise<CollectionSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const invocationId = await startInvocation(env.FORECAST_DB, env.DEPLOY_SHA, nowMs, env.POLL_MODE);
  const circuit = await invocationCircuitState(env.FORECAST_DB, nowMs);
  if (circuit.open) {
    await finishInvocation(
      env.FORECAST_DB,
      invocationId,
      "circuit_open",
      0,
      "naver_circuit_open",
      circuit.nextRetryAt,
    );
    return { outcome: "circuit_open", polledSources: 0, queuedItems: 0 };
  }

  const boards = sourcesForInvocation(env.POLL_MODE, nowMs);
  try {
    let queuedItems = 0;
    for (const boardId of boards) queuedItems += await pollNaverSource(env.FORECAST_DB, boardId);
    await finishInvocation(env.FORECAST_DB, invocationId, "completed", queuedItems, null, null);
    return { outcome: "completed", polledSources: boards.length, queuedItems };
  } catch (error) {
    const errorCode = sanitizeErrorCode(error);
    const nextRetryAt = nextNaverRetryAt(nowMs, circuit.failures + 1);
    await finishInvocation(env.FORECAST_DB, invocationId, "failure", 0, errorCode, nextRetryAt);
    return { outcome: "failure", polledSources: boards.length, queuedItems: 0 };
  }
}

function sanitizeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown";
  return message.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}
