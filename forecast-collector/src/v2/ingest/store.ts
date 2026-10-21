import {
  BUDGET_UNEXPLAINED_ERROR_CODE,
  type BudgetIncidentKind,
  budgetGameDayResetAt,
  budgetIncidentKey,
  budgetUnexplainedAlertKey,
} from "../../../../shared/forecastOpsAlerts";
import {
  type OpsEnvironment,
  resolveBudgetIncidentsBeforeStatement,
  upsertOpsAlert,
} from "../../ops";
import { IngestFailure, type Metadata } from "./client";
import { budgetGameDay, type Stream } from "./schedule";
import { nextBoundary, type Scan } from "./traversal";

export type Lease = { stream: Stream; owner: string; expiresAt: string };
type BudgetRow = {
  metadata_used: number;
  metadata_limit: number;
  detail_used: number;
  detail_limit: number;
};
export class MonitorStore {
  constructor(
    private readonly db: D1Database,
    private readonly environment?: OpsEnvironment,
    private readonly clock?: () => string,
  ) {}

  private leaseTime(now: number) {
    return this.clock?.() ?? new Date(now).toISOString();
  }

  async alert(stream: Stream, reason: string, now: number) {
    if (!this.environment) return;
    await upsertOpsAlert(this.db, {
      alertKey: `forecast-v2:${this.environment}:${stream}:${reason}`,
      environment: this.environment,
      severity: "warning",
      component: "collector",
      errorCode: reason,
      context: { stream },
      nowMs: now,
    });
  }

  /**
   * Exhausted daily limits are an incident per budget kind and game day, not per
   * stream: every stream that can no longer fetch joins the same row, so the
   * dispatcher delivers one message instead of one per stream plus renewals.
   * Which limit ran out is read from that game day's budget row; without one
   * (or with neither column at its limit) the per-stream hold alert stands.
   */
  private async budgetAlert(stream: Stream, now: number) {
    const environment = this.environment;
    if (!environment) return;
    const gameDay = budgetGameDay(now);
    const budget = await this.db
      .prepare(`SELECT metadata_used,metadata_limit,detail_used,detail_limit
      FROM forecast_v2_request_budgets WHERE game_day=?`)
      .bind(gameDay)
      .first<BudgetRow>();
    const exhausted =
      budget === null
        ? []
        : BUDGET_KINDS.flatMap((kind) => {
            const used = kind === "metadata" ? budget.metadata_used : budget.detail_used;
            const limit = kind === "metadata" ? budget.metadata_limit : budget.detail_limit;
            return used >= limit ? [{ kind, used, limit }] : [];
          });
    if (!exhausted.length) {
      // No budget row explains the admission failure, so it is not a daily-limit
      // incident: keep the ordinary per-stream alert policy under its own code, since
      // the superseded `budget_exhausted` keys are retired by the dispatcher.
      await upsertOpsAlert(this.db, {
        alertKey: budgetUnexplainedAlertKey(environment, stream),
        environment,
        severity: "warning",
        component: "collector",
        errorCode: BUDGET_UNEXPLAINED_ERROR_CODE,
        context: { stream, gameDay },
        nowMs: now,
      });
      return;
    }
    for (const { kind, used, limit } of exhausted)
      await this.upsertBudgetIncident(environment, stream, kind, gameDay, used, limit, now);
  }

  private async upsertBudgetIncident(
    environment: OpsEnvironment,
    stream: Stream,
    kind: BudgetIncidentKind,
    gameDay: string,
    used: number,
    limit: number,
    now: number,
  ) {
    await upsertOpsAlert(this.db, {
      alertKey: budgetIncidentKey(environment, kind, gameDay),
      environment,
      severity: "warning",
      component: "collector",
      errorCode: "budget_exhausted",
      context: {
        gameDay,
        kind,
        used,
        limit,
        resetAt: budgetGameDayResetAt(gameDay),
        affectedStreams: stream,
      },
      // Concurrent leases on other streams union into the row's own value atomically.
      mergeAffectedStream: stream,
      nowMs: now,
    });
  }

  async acquire(stream: Stream, now: number): Promise<Lease | null> {
    const owner = crypto.randomUUID();
    const time = this.leaseTime(now);
    const expiresAt = new Date(Date.parse(time) + 120_000).toISOString();
    const row = await this.db
      .prepare(`UPDATE forecast_v2_monitor_state
      SET lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE stream_id=? AND (lease_owner IS NULL OR lease_expires_at<=?)
      RETURNING stream_id`)
      .bind(owner, expiresAt, new Date(now).toISOString(), stream, time)
      .first();
    return row ? { stream, owner, expiresAt } : null;
  }

  async release(lease: Lease) {
    // Cleanup may release this owner's expired lease, but never a successor's.
    const result = await this.db
      .prepare(`UPDATE forecast_v2_monitor_state SET lease_owner=NULL,lease_expires_at=NULL
      WHERE stream_id=? AND lease_owner=?`)
      .bind(lease.stream, lease.owner)
      .run();
    if (result.meta.changes === 0)
      console.info(
        JSON.stringify({
          event: "forecast_v2_write_skipped",
          operation: "release",
          stream: lease.stream,
          reason: "lease_not_owned",
        }),
      );
  }

  async reserve(
    lease: Lease,
    runId: string,
    kind: "metadata" | "detail",
    now: number,
    feedId: string | null = null,
  ) {
    const day = budgetGameDay(now);
    const time = new Date(now).toISOString();
    const id = crypto.randomUUID();
    const column = kind === "metadata" ? "metadata" : "detail";
    // A batch is atomic: a failed attempt insert cannot consume an unrecorded budget.
    // The insert precedes the increment so both share the same admission predicate.
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO forecast_v2_request_budgets(game_day) VALUES(?) ON CONFLICT DO NOTHING`,
        )
        .bind(day),
      this.db
        .prepare(`INSERT INTO forecast_v2_fetch_attempts
        (attempt_id,run_id,feed_id,kind,game_day,attempted_at,outcome)
        SELECT ?,?,?,?,?,?,'reserved' WHERE EXISTS(
          SELECT 1 FROM forecast_v2_request_budgets WHERE game_day=? AND ${column}_used<${column}_limit)
        AND EXISTS(SELECT 1 FROM forecast_v2_monitor_state
          WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)`)
        .bind(
          id,
          runId,
          feedId,
          kind,
          day,
          time,
          day,
          lease.stream,
          lease.owner,
          this.leaseTime(now),
        ),
      this.db
        .prepare(`UPDATE forecast_v2_request_budgets SET ${column}_used=${column}_used+1
        WHERE game_day=? AND EXISTS(SELECT 1 FROM forecast_v2_fetch_attempts WHERE attempt_id=?)`)
        .bind(day, id),
      // The first successful reservation of a game day proves the previous game day
      // ended at 05:00 KST, so its budget incident closes silently in this same batch
      // (guarded by this reservation's own attempt row; a no-op otherwise).
      ...(this.environment
        ? [resolveBudgetIncidentsBeforeStatement(this.db, this.environment, day, now, id)]
        : []),
    ]);
    if (result[1]?.meta.changes !== 1) throw new IngestFailure("budget_or_lease");
    if (result[2]?.meta.changes !== 1) throw new IngestFailure("budget_accounting");
    // Budget-row creation may conflict; incident resolution may match no rows.
    return id;
  }

  async finishAttempt(id: string, error: IngestFailure | null, now: number) {
    const result = await this.db
      .prepare(`UPDATE forecast_v2_fetch_attempts SET outcome=?,error_code=?,next_attempt_at=
      CASE WHEN ?=1 OR (kind='detail' AND ? IS NOT NULL AND ? NOT IN ('http_404','detail_drift','lease_lost'))
        THEN ? ELSE NULL END
      WHERE attempt_id=? AND outcome='reserved'`)
      .bind(
        error ? "failure" : "success",
        error?.code ?? null,
        error?.retryable ? 1 : 0,
        error?.code ?? null,
        error?.code ?? null,
        new Date(now + 180_000).toISOString(),
        id,
      )
      .run();
    if (result.meta.changes === 1) return;
    const existing = await this.db
      .prepare("SELECT outcome FROM forecast_v2_fetch_attempts WHERE attempt_id=?")
      .bind(id)
      .first<{ outcome: string }>();
    if (!existing) throw new IngestFailure("attempt_missing");
    if (existing.outcome === "reserved") throw new IngestFailure("attempt_not_finalized");
    // A later cleanup must not overwrite the first durable result.
    console.info(
      JSON.stringify({
        event: "forecast_v2_write_skipped",
        operation: "finish_attempt",
        reason: "attempt_already_finalized",
        outcome: existing.outcome,
      }),
    );
  }

  async bodyAttempts(item: Metadata) {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS count, MAX(a.next_attempt_at) AS next
      FROM forecast_v2_fetch_attempts a JOIN forecast_v2_search_hits h
        ON h.run_id=a.run_id AND h.feed_id=a.feed_id
      WHERE a.kind='detail' AND h.feed_id=? AND h.updated_date=?`)
      .bind(item.feedId, item.updatedAt)
      .first<{ count: number; next: string | null }>();
    if (!row) throw new IngestFailure("body_attempts_missing");
    return row;
  }

  async metadataAttempts(runId: string) {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS failures,MAX(next_attempt_at) AS next
        FROM forecast_v2_fetch_attempts WHERE run_id=? AND kind='metadata'
          AND outcome IN ('failure','reserved')
          AND (error_code IS NULL OR error_code<>'lease_lost')`)
      .bind(runId)
      .first<{ failures: number; next: string | null }>();
    if (!row) throw new IngestFailure("metadata_attempts_missing");
    return row;
  }

  async disposeBody(
    lease: Lease,
    item: Metadata,
    disposition: "failed" | "deleted" | "refresh",
    reason: string,
    now: number,
  ) {
    const time = this.leaseTime(now);
    const fence = `EXISTS(SELECT 1 FROM forecast_v2_monitor_state WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)`;
    const writes = [
      this.db
        .prepare(`UPDATE forecast_v2_search_hits SET metadata_json=json_set(metadata_json,
        '$.bodyDisposition',?,'$.bodyFailure',?) WHERE feed_id=? AND updated_date=? AND ${fence}`)
        .bind(disposition, reason, item.feedId, item.updatedAt, lease.stream, lease.owner, time),
    ];
    if (disposition === "refresh")
      writes.push(
        this.db
          .prepare(`UPDATE forecast_v2_monitor_state
      SET edit_scan_completed_at=NULL,edit_scan_cutoff=? WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?
        AND EXISTS(SELECT 1 FROM forecast_v2_search_hits WHERE feed_id=? AND updated_date=?)`)
          .bind(
            new Date(now - 14 * 86_400_000).toISOString(),
            lease.stream,
            lease.owner,
            time,
            item.feedId,
            item.updatedAt,
          ),
      );
    const results = await this.db.batch(writes);
    if (!results[0]?.meta.changes) throw new IngestFailure("body_disposition_not_written");
    if (disposition === "refresh" && results[1]?.meta.changes !== 1)
      throw new IngestFailure("lease_lost");
  }

  async hold(lease: Lease, reason: string, now: number) {
    const row = await this.db
      .prepare(`UPDATE forecast_v2_monitor_state
      SET consecutive_holds=consecutive_holds+1,updated_at=?
      WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?
      RETURNING consecutive_holds`)
      .bind(new Date(now).toISOString(), lease.stream, lease.owner, this.leaseTime(now))
      .first<{ consecutive_holds: number }>();
    if (!row) {
      console.warn(
        JSON.stringify({
          event: "forecast_v2_write_skipped",
          operation: "hold",
          stream: lease.stream,
          reason: "lease_lost",
        }),
      );
      return "lease_lost";
    }
    if (
      row.consecutive_holds >= 3 ||
      reason === "budget_exhausted" ||
      reason === "attempts_exhausted" ||
      reason === "metadata_attempts_exhausted" ||
      reason === "missing_boundary"
    ) {
      await (reason === "budget_exhausted"
        ? this.budgetAlert(lease.stream, now)
        : this.alert(lease.stream, reason, now));
      console.error(
        JSON.stringify({
          event: "forecast_v2_stale_coverage",
          stream: lease.stream,
          reason,
          holds: row.consecutive_holds,
        }),
      );
    }
    return reason;
  }

  async commitPage(
    lease: Lease,
    runId: string,
    scan: Scan,
    now: number,
    leaseTime = this.leaseTime(now),
  ) {
    const time = new Date(now).toISOString();
    const fence = `EXISTS(SELECT 1 FROM forecast_v2_monitor_state
      WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)`;
    const boundary = scan.status === "completed" ? nextBoundary(scan) : scan.boundary;
    // A capped edit remains held (coverage is incomplete), but its next restart
    // observes the same cooldown as a completed edit, atomically with the page.
    const editCooldown =
      scan.kind === "edit" &&
      (scan.status === "completed" ||
        scan.reason === "page_cap" ||
        scan.reason === "metadata_attempts_exhausted");
    const writes = scan.hits.map((hit) =>
      this.db
        .prepare(`INSERT INTO forecast_v2_search_hits
      (run_id,feed_id,created_at,updated_date,metadata_json)
      SELECT ?,?,?,?,? WHERE ${fence} ON CONFLICT(run_id,feed_id) DO NOTHING`)
        .bind(
          runId,
          hit.feedId,
          hit.createdAt,
          hit.updatedAt,
          JSON.stringify(hit),
          lease.stream,
          lease.owner,
          leaseTime,
        ),
    );
    writes.push(
      this.db
        .prepare(`UPDATE forecast_v2_monitor_runs SET continuation_cursor=?,pages_used=?,
      status=?,finished_at=?,error_code=? WHERE run_id=? AND ${fence}`)
        .bind(
          scan.page,
          scan.page,
          scan.status,
          scan.status === "running" ? null : time,
          scan.reason,
          runId,
          lease.stream,
          lease.owner,
          leaseTime,
        ),
    );
    writes.push(
      this.db
        .prepare(`UPDATE forecast_v2_monitor_state SET
      committed_created_at=CASE WHEN ?='new' THEN ? ELSE committed_created_at END,
      committed_feed_ids_json=CASE WHEN ?='new' THEN ? ELSE committed_feed_ids_json END,
      continuation_cursor=CASE WHEN ?='new' THEN ? ELSE continuation_cursor END,
      edit_scan_cursor=CASE WHEN ?='edit' THEN ? ELSE edit_scan_cursor END,
      edit_scan_cutoff=CASE WHEN ?='edit' THEN ? ELSE edit_scan_cutoff END,
      edit_scan_completed_at=CASE WHEN ? THEN ? ELSE edit_scan_completed_at END,
      consecutive_holds=CASE WHEN ?='completed' THEN 0 ELSE consecutive_holds END,updated_at=?
      WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?
        AND EXISTS(SELECT 1 FROM forecast_v2_monitor_runs WHERE run_id=? AND stream_id=?)`)
        .bind(
          scan.kind,
          boundary.createdAt,
          scan.kind,
          JSON.stringify(boundary.feedIds),
          scan.kind,
          scan.status === "completed" ? 0 : scan.page,
          scan.kind,
          editCooldown ? 0 : scan.page,
          scan.kind,
          editCooldown ? null : scan.boundary.createdAt,
          Number(editCooldown),
          time,
          scan.status,
          time,
          lease.stream,
          lease.owner,
          leaseTime,
          runId,
          lease.stream,
        ),
    );
    const results = await this.db.batch(writes);
    if (results.at(-1)?.meta.changes !== 1) throw new IngestFailure("lease_lost");
    if (results.at(-2)?.meta.changes !== 1) throw new IngestFailure("page_run_not_written");
    // Hit inserts may be no-ops for already persisted (run, feed) pairs.
  }
}

const BUDGET_KINDS: readonly BudgetIncidentKind[] = ["metadata", "detail"];
