import { nextNaverRetryAt } from "./db";
import { resolveOpsAlertsByPrefix, upsertOpsAlert } from "./ops";
import {
  finishInvocation,
  invocationCircuitState,
  NaverPartialSchemaError,
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
    for (const boardId of boards) {
      try {
        queuedItems += await pollNaverSource(env.FORECAST_DB, boardId);
        await resolveOpsAlertsByPrefix(
          env.FORECAST_DB,
          `naver-schema:${opsEnvironment(env)}:${boardId}:`,
          nowMs,
        );
      } catch (error) {
        if (error instanceof NaverPartialSchemaError) {
          const first = error.rejected[0];
          await upsertOpsAlert(env.FORECAST_DB, {
            alertKey: `naver-schema:${opsEnvironment(env)}:${boardId}:${first?.shapeHash ?? "unknown"}`,
            environment: opsEnvironment(env),
            severity: "critical",
            component: "naver-metadata",
            errorCode: "naver_partial_schema_drift",
            context: {
              board: boardId,
              offset: error.offset,
              rowIndex: first?.index ?? -1,
              topLevelKeys: (first?.topLevelKeys ?? []).join(",").slice(0, 300),
              shapeHash: first?.shapeHash ?? null,
              rejectedCount: error.rejected.length,
            },
            nowMs,
          });
        }
        throw error;
      }
    }
    await finishInvocation(env.FORECAST_DB, invocationId, "completed", queuedItems, null, null);
    return { outcome: "completed", polledSources: boards.length, queuedItems };
  } catch (error) {
    const errorCode = sanitizeErrorCode(error);
    const nextRetryAt = nextNaverRetryAt(nowMs, circuit.failures + 1);
    await finishInvocation(env.FORECAST_DB, invocationId, "failure", 0, errorCode, nextRetryAt);
    return { outcome: "failure", polledSources: boards.length, queuedItems: 0 };
  }
}

function opsEnvironment(env: CollectorEnv) {
  return env.ENVIRONMENT === "production" ? "production" : "staging";
}

function sanitizeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown";
  return message.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}
