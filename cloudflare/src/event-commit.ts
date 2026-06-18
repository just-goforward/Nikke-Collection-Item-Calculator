import { clientEnvironment } from "./client-environment";
import type { WorkerEnv } from "./env";
import type {
  ValidatedKitResultEvent,
  ValidatedSolverDiagnosticEvent,
  ValidatedSubmission,
} from "./event-validation-types";
import { HttpError } from "./http-error";
import { kstDateKeyFromUnixSeconds } from "./stats-read";

type StatsEventKind = "kit_result" | "solver_diagnostic";

export async function commitSubmission(
  request: Request,
  env: WorkerEnv,
  normalized: ValidatedSubmission,
  now: number,
) {
  const dateKey = kstDateKeyFromUnixSeconds(now);
  if (normalized.event.kind === "solver_diagnostic") {
    return commitEvent(env, normalized.eventId, now, normalized.event.kind, [
      buildSolverDiagnosticAggregateStatement(env, dateKey, normalized.event, now),
      buildSolverNodeCountAggregateStatement(env, dateKey, normalized.event, now),
      buildSolverRuntimeAggregateStatement(env, dateKey, normalized.event, now),
    ]);
  }

  return commitKitResultEvent(
    request,
    env,
    normalized.eventId,
    normalized.sourceHost,
    normalized.event,
    dateKey,
    now,
  );
}

function buildSolverNodeCountAggregateStatement(
  env: WorkerEnv,
  dateKey: string,
  event: ValidatedSolverDiagnosticEvent,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO solver_node_count_aggregates
      (date_key, diagnostic_version, solver_version, solver_phase, node_count_bucket, events, last_seen)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, diagnostic_version, solver_version, solver_phase, node_count_bucket)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
  ).bind(
    dateKey,
    event.diagnosticVersion,
    event.solverVersion,
    event.solverPhase,
    event.nodeCountBucket,
    now,
  );
}

function buildSolverRuntimeAggregateStatement(
  env: WorkerEnv,
  dateKey: string,
  event: ValidatedSolverDiagnosticEvent,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO solver_runtime_aggregates
      (date_key, diagnostic_version, solver_version, solver_phase, solver_backend,
       fallback_from, fallback_reason, grade, level, exp_bucket,
       stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       node_count_bucket, solve_ms_bucket, events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, diagnostic_version, solver_version, solver_phase, solver_backend,
       fallback_from, fallback_reason, grade, level, exp_bucket,
       stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       node_count_bucket, solve_ms_bucket)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
  ).bind(
    dateKey,
    event.diagnosticVersion,
    event.solverVersion,
    event.solverPhase,
    event.solverBackend,
    event.fallbackFrom,
    event.fallbackReason,
    event.start.grade,
    event.start.level,
    event.start.exp,
    event.stockBuckets.blue,
    event.stockBuckets.purple,
    event.stockBuckets.yellow,
    event.nodeCountBucket,
    event.solveMsBucket,
    now,
  );
}

async function commitKitResultEvent(
  request: Request,
  env: WorkerEnv,
  eventId: string,
  sourceHost: string,
  event: ValidatedKitResultEvent,
  dateKey: string,
  now: number,
) {
  const successAttempt = event.successAttempt || 0;
  const attempts = event.outcome === "great_success" ? successAttempt : event.recommendedUses;
  const greatSuccesses = event.outcome === "great_success" ? 1 : 0;
  const environment = clientEnvironment(request);

  return commitEvent(env, eventId, now, "kit_result", [
    env.DB.prepare(
      `INSERT INTO event_aggregates
      (date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt, events, attempts, great_successes, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt)
     DO UPDATE SET
      events = events + 1,
      attempts = attempts + excluded.attempts,
      great_successes = great_successes + excluded.great_successes,
      last_seen = excluded.last_seen`,
    ).bind(
      dateKey,
      event.start.grade,
      event.start.level,
      event.start.exp,
      event.kit,
      event.recommendedUses,
      event.outcome,
      successAttempt,
      attempts,
      greatSuccesses,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO referrer_aggregates
      (date_key, source_host, events, last_seen)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(date_key, source_host)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
    ).bind(dateKey, sourceHost, now),
    env.DB.prepare(
      `INSERT INTO client_env_aggregates
      (date_key, browser, browser_major, os, os_major, device_type, events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, browser, browser_major, os, os_major, device_type)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
    ).bind(
      dateKey,
      environment.browser,
      environment.browserMajor,
      environment.os,
      environment.osMajor,
      environment.deviceType,
      now,
    ),
  ]);
}

async function commitEvent(
  env: WorkerEnv,
  eventId: string,
  now: number,
  eventKind: StatsEventKind,
  aggregateStatements: D1PreparedStatement[],
): Promise<boolean> {
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO event_ids (id, created_at) VALUES (?, ?)").bind(eventId, now),
      ...aggregateStatements,
    ]);
    return false;
  } catch (error) {
    let existing: { event_exists?: number } | null;
    try {
      existing = await env.DB.prepare("SELECT 1 AS event_exists FROM event_ids WHERE id = ?")
        .bind(eventId)
        .first<{ event_exists?: number }>();
    } catch {
      console.error("Statistics event storage lookup failed.", {
        eventKind,
        error: error instanceof Error ? error.message : "unknown_error",
      });
      throw new HttpError(503, "storage_unavailable", true);
    }
    if (existing?.event_exists === 1) return true;
    console.error("Statistics event storage failed.", {
      eventKind,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    throw new HttpError(503, "storage_unavailable", true);
  }
}

function buildSolverDiagnosticAggregateStatement(
  env: WorkerEnv,
  dateKey: string,
  event: ValidatedSolverDiagnosticEvent,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO solver_diagnostic_aggregates
      (date_key, diagnostic_version, solver_version, solver_phase, grade, level, exp_bucket,
       strategy, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       recommended_kit, recommended_uses_bucket, candidate_count_bucket,
       probability_gap_bucket, resource_cost_bucket, legacy_supply_cost_bucket,
       total_expected_cost_bucket,
       blue_share_bucket, min_autonomy_days_bucket, changed_from_single,
       changed_from_legacy_supply, legacy_private_stats_available,
       legacy_event_aggregate_matchable, events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, diagnostic_version, solver_version, solver_phase, grade, level,
       exp_bucket, strategy, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       recommended_kit, recommended_uses_bucket, candidate_count_bucket,
       probability_gap_bucket, resource_cost_bucket, legacy_supply_cost_bucket,
       total_expected_cost_bucket,
       blue_share_bucket, min_autonomy_days_bucket, changed_from_single,
       changed_from_legacy_supply, legacy_private_stats_available,
       legacy_event_aggregate_matchable)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
  ).bind(
    dateKey,
    event.diagnosticVersion,
    event.solverVersion,
    event.solverPhase,
    event.start.grade,
    event.start.level,
    event.start.exp,
    event.strategy,
    event.stockBuckets.blue,
    event.stockBuckets.purple,
    event.stockBuckets.yellow,
    event.recommendedKit,
    event.recommendedUsesBucket,
    event.candidateCountBucket,
    event.probabilityGapBucket,
    event.resourceCostBucket,
    event.legacySupplyCostBucket,
    event.totalExpectedCostBucket,
    event.blueShareBucket,
    event.minAutonomyDaysBucket,
    event.changedFromSingle,
    event.changedFromLegacySupply,
    event.legacyPrivateStatsAvailable ? 1 : 0,
    event.legacyEventAggregateMatchable ? 1 : 0,
    now,
  );
}
