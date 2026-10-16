import { nextNaverRetryAt } from "./db";
import { resolveOpsAlertsByPrefix, upsertOpsAlert } from "./ops";
import type { ProfileCounts } from "./profile";
import {
  finishInvocation,
  invocationCircuitState,
  NaverBoundaryHeldError,
  NaverPartialSchemaError,
  NaverScanBoundaryError,
  pollNaverSource,
  sourcesForInvocation,
  startInvocation,
} from "./source-queue";
import type { CollectionSummary, CollectorEnv } from "./types";

export async function runCollection(
  env: CollectorEnv,
  options: { nowMs?: number; board?: 48 | 56; counts?: ProfileCounts; rotation?: boolean } = {},
): Promise<CollectionSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const rotationBoard = options.rotation ? options.board : undefined;
  const invocationId = await startInvocation(
    env.FORECAST_DB,
    env.DEPLOY_SHA,
    nowMs,
    env.POLL_MODE,
    collectionPrefix(options.board, options.counts),
    rotationBoard,
  );
  if (invocationId === null) return { outcome: "completed", polledSources: 0, queuedItems: 0 };
  const circuit = await invocationCircuitState(env.FORECAST_DB, nowMs, rotationBoard);
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

  const boards = options.board ? [options.board] : sourcesForInvocation(env.POLL_MODE, nowMs);
  let queuedItems = 0;
  let errorCode: string | null = null;
  let holdCode: string | null = null;
  let successfulSources = 0;
  let staleSources = 0;
  for (const boardId of boards) {
    try {
      const queued = await pollCollectionSource(env, boardId, nowMs, options.counts);
      if (queued === null) {
        staleSources += 1;
        continue;
      }
      queuedItems += queued;
      await resolveOpsAlertsByPrefix(
        env.FORECAST_DB,
        `naver-schema:${opsEnvironment(env)}:${boardId}:`,
        nowMs,
      );
      successfulSources += 1;
    } catch (error) {
      if (error instanceof NaverScanBoundaryError) queuedItems += error.queuedItems;
      if (isBoundaryHoldError(error)) {
        holdCode ??= sanitizeErrorCode(error);
      } else {
        errorCode ??= sanitizeErrorCode(error);
      }
    }
  }
  if (errorCode !== null) {
    const nextRetryAt = nextNaverRetryAt(nowMs, circuit.failures + 1);
    await finishInvocation(
      env.FORECAST_DB,
      invocationId,
      "failure",
      queuedItems,
      errorCode,
      nextRetryAt,
    );
    return { outcome: "failure", polledSources: boards.length, queuedItems };
  }
  if (holdCode !== null) {
    await finishInvocation(
      env.FORECAST_DB,
      invocationId,
      "failure",
      queuedItems,
      heldInvocationCode(holdCode, successfulSources),
      null,
    );
    return { outcome: "held", polledSources: boards.length, queuedItems };
  }
  await finishInvocation(
    env.FORECAST_DB,
    invocationId,
    "completed",
    queuedItems,
    staleSources === boards.length ? "naver_stale_poll_only" : null,
    null,
  );
  return { outcome: "completed", polledSources: boards.length, queuedItems };
}

async function pollCollectionSource(
  env: CollectorEnv,
  boardId: 48 | 56,
  nowMs: number,
  counts?: ProfileCounts,
) {
  try {
    return await pollNaverSource(env.FORECAST_DB, boardId, fetch, opsEnvironment(env), counts);
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

function collectionPrefix(board?: 48 | 56, counts?: ProfileCounts) {
  return board ? `profile-board-${board}:` : counts ? "profile-poll:" : "";
}

function opsEnvironment(env: CollectorEnv) {
  return env.ENVIRONMENT === "production" ? "production" : "staging";
}

function isBoundaryHoldError(error: unknown) {
  return error instanceof NaverScanBoundaryError || error instanceof NaverBoundaryHeldError;
}

function heldInvocationCode(holdCode: string, successfulSources: number) {
  return successfulSources > 0 ? holdCode : "naver_boundary_held_only";
}

function sanitizeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown";
  return message.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}
