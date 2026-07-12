import { clientEnvironment } from "./client-environment";
import { kstDateKeyFromUnixSeconds } from "./date-key";
import type { WorkerEnv } from "./env";
import type {
  ValidatedKitResultEvent,
  ValidatedSolverDiagnosticEvent,
  ValidatedSolverRecoveryEvent,
  ValidatedSubmission,
} from "./event-validation-types";
import { HttpError } from "./http-error";
import { logError, sanitizedError } from "./logger";

type StatsEventKind = "kit_result" | "solver_diagnostic" | "solver_recovery";

export async function commitSubmission(
  request: Request,
  env: WorkerEnv,
  normalized: ValidatedSubmission,
  now: number,
) {
  const dateKey = kstDateKeyFromUnixSeconds(now);
  if (normalized.event.kind === "solver_diagnostic") {
    const aggregateStatements = [
      buildSolverDiagnosticAggregateStatement(env, dateKey, normalized.event, now),
      buildSolverCacheAggregateStatement(env, dateKey, normalized.event, now),
    ];
    if (normalized.event.executionKind === "executed") {
      aggregateStatements.push(
        buildSolverRuntimeAggregateStatement(env, dateKey, normalized.event, now),
      );
    }
    return commitEvent(env, normalized.eventId, now, normalized.event.kind, aggregateStatements);
  }
  if (normalized.event.kind === "solver_recovery") {
    const event = normalized.event;
    const environment = clientEnvironment(request);
    const aggregateStatements = [
      buildSolverRecoveryTerminalStatement(env, dateKey, event, environment.deviceType, now),
      ...recoveryRungs(event).map((rung) =>
        buildSolverRecoveryRungStatement(env, dateKey, event, rung, environment.deviceType, now),
      ),
    ];
    return commitEvent(env, normalized.eventId, now, normalized.event.kind, aggregateStatements);
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

type RecoveryRung = { backend: string; exit: string; memoTier: string };

function recoveryRungs(event: ValidatedSolverRecoveryEvent): RecoveryRung[] {
  const rungs = [
    { backend: "rust-min-ef", exit: event.minEfExit, memoTier: event.minEfMemoTier },
    { backend: "rust-phase2", exit: event.phase2Exit, memoTier: event.phase2MemoTier },
    { backend: "js-phase2", exit: event.jsExit, memoTier: "unknown" },
  ];
  return rungs.filter((rung) => rung.exit !== "not_attempted");
}

function buildSolverRecoveryRungStatement(
  env: WorkerEnv,
  dateKey: string,
  event: ValidatedSolverRecoveryEvent,
  rung: RecoveryRung,
  deviceType: string,
  now: number,
) {
  return env.DB.prepare(
    `INSERT INTO solver_recovery_rung_aggregates
      (date_key, recovery_version, policy_version, requested_backend, rung_backend, rung_exit,
       memo_tier, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
       stock_bucket_yellow, device_type, events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, recovery_version, policy_version, requested_backend, rung_backend,
       rung_exit, memo_tier, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
       stock_bucket_yellow, device_type)
     DO UPDATE SET events = events + 1, last_seen = excluded.last_seen`,
  ).bind(
    dateKey,
    event.recoveryVersion,
    event.policyVersion,
    event.requestedBackend,
    rung.backend,
    rung.exit,
    rung.memoTier,
    event.start.grade,
    event.start.level,
    event.start.exp,
    event.stockBuckets.blue,
    event.stockBuckets.purple,
    event.stockBuckets.yellow,
    deviceType,
    now,
  );
}

function buildSolverRecoveryTerminalStatement(
  env: WorkerEnv,
  dateKey: string,
  event: ValidatedSolverRecoveryEvent,
  deviceType: string,
  now: number,
) {
  return env.DB.prepare(
    `INSERT INTO solver_recovery_terminal_aggregates
      (date_key, recovery_version, policy_version, requested_backend, min_ef_exit, phase2_exit,
       js_exit, terminal_backend, terminal_outcome, grade, level, exp_bucket, stock_bucket_blue,
       stock_bucket_purple, stock_bucket_yellow, device_type, events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, recovery_version, policy_version, requested_backend, min_ef_exit,
       phase2_exit, js_exit, terminal_backend, terminal_outcome, grade, level, exp_bucket,
       stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, device_type)
     DO UPDATE SET events = events + 1, last_seen = excluded.last_seen`,
  ).bind(
    dateKey,
    event.recoveryVersion,
    event.policyVersion,
    event.requestedBackend,
    event.minEfExit,
    event.phase2Exit,
    event.jsExit,
    event.terminalBackend,
    event.terminalOutcome,
    event.start.grade,
    event.start.level,
    event.start.exp,
    event.stockBuckets.blue,
    event.stockBuckets.purple,
    event.stockBuckets.yellow,
    deviceType,
    now,
  );
}

function buildSolverCacheAggregateStatement(
  env: WorkerEnv,
  dateKey: string,
  event: ValidatedSolverDiagnosticEvent,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO solver_cache_aggregates
      (date_key, diagnostic_version, requested_backend, terminal_backend, execution_kind,
       grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, diagnostic_version, requested_backend, terminal_backend,
       execution_kind, grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple,
       stock_bucket_yellow)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
  ).bind(
    dateKey,
    event.diagnosticVersion,
    event.requestedBackend,
    event.solverBackend,
    event.executionKind,
    event.start.grade,
    event.start.level,
    event.start.exp,
    event.stockBuckets.blue,
    event.stockBuckets.purple,
    event.stockBuckets.yellow,
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
       fallback_from, fallback_reason, memory_strategy, min_ef_memo_tier,
       phase2_memo_tier, phase2_memo_retried, grade, level, exp_bucket,
       stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       node_count_bucket, attempted_node_count_bucket, solve_ms_bucket, events, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, diagnostic_version, solver_version, solver_phase, solver_backend,
       fallback_from, fallback_reason, memory_strategy, min_ef_memo_tier,
       phase2_memo_tier, phase2_memo_retried, grade, level, exp_bucket,
       stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       node_count_bucket, attempted_node_count_bucket, solve_ms_bucket)
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
    event.memoryStrategy,
    event.minEfMemoTier,
    event.phase2MemoTier,
    event.phase2MemoRetried,
    event.start.grade,
    event.start.level,
    event.start.exp,
    event.stockBuckets.blue,
    event.stockBuckets.purple,
    event.stockBuckets.yellow,
    event.nodeCountBucket,
    event.attemptedNodeCountBucket,
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
    } catch (lookupError) {
      logError("statistics_event_storage_lookup_failed", {
        eventKind,
        duplicateLookupError: sanitizedError(lookupError),
        primaryWriteError: sanitizedError(error),
      });
      throw new HttpError(503, "storage_unavailable", true);
    }
    if (existing?.event_exists === 1) return true;
    logError("statistics_event_storage_failed", {
      eventKind,
      primaryWriteError: sanitizedError(error),
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
