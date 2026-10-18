import { type OpsEnvironment, upsertOpsAlert } from "../../ops";
import { IngestFailure, type Metadata } from "./client";
import { budgetGameDay, type Stream } from "./schedule";
import { nextBoundary, type Scan } from "./traversal";

export type Lease = { stream: Stream; owner: string; expiresAt: string };
export class MonitorStore {
  constructor(
    private readonly db: D1Database,
    private readonly environment?: OpsEnvironment,
  ) {}

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

  async acquire(stream: Stream, now: number): Promise<Lease | null> {
    const owner = crypto.randomUUID();
    const expiresAt = new Date(now + 120_000).toISOString();
    const row = await this.db
      .prepare(`UPDATE forecast_v2_monitor_state
      SET lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE stream_id=? AND (lease_owner IS NULL OR lease_expires_at<=?)
      RETURNING stream_id`)
      .bind(owner, expiresAt, new Date(now).toISOString(), stream, new Date(now).toISOString())
      .first();
    return row ? { stream, owner, expiresAt } : null;
  }

  async release(lease: Lease) {
    await this.db
      .prepare(`UPDATE forecast_v2_monitor_state SET lease_owner=NULL,lease_expires_at=NULL
      WHERE stream_id=? AND lease_owner=?`)
      .bind(lease.stream, lease.owner)
      .run();
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
        .bind(id, runId, feedId, kind, day, time, day, lease.stream, lease.owner, time),
      this.db
        .prepare(`UPDATE forecast_v2_request_budgets SET ${column}_used=${column}_used+1
        WHERE game_day=? AND EXISTS(SELECT 1 FROM forecast_v2_fetch_attempts WHERE attempt_id=?)`)
        .bind(day, id),
    ]);
    if (result[1]?.meta.changes !== 1) throw new IngestFailure("budget_or_lease");
    return id;
  }

  async finishAttempt(id: string, error: IngestFailure | null, now: number) {
    await this.db
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
  }

  async bodyAttempts(item: Metadata) {
    return (await this.db
      .prepare(`SELECT COUNT(*) AS count, MAX(a.next_attempt_at) AS next
      FROM forecast_v2_fetch_attempts a JOIN forecast_v2_search_hits h
        ON h.run_id=a.run_id AND h.feed_id=a.feed_id
      WHERE a.kind='detail' AND h.feed_id=? AND h.updated_date=?`)
      .bind(item.feedId, item.updatedAt)
      .first<{ count: number; next: string | null }>())!;
  }

  async disposeBody(
    lease: Lease,
    item: Metadata,
    disposition: "failed" | "deleted" | "refresh",
    reason: string,
    now: number,
  ) {
    const time = new Date(now).toISOString();
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
      SET edit_scan_completed_at=NULL,edit_scan_cutoff=? WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?`)
          .bind(new Date(now - 14 * 86_400_000).toISOString(), lease.stream, lease.owner, time),
      );
    await this.db.batch(writes);
  }

  async hold(lease: Lease, reason: string, now: number) {
    const row = await this.db
      .prepare(`UPDATE forecast_v2_monitor_state
      SET consecutive_holds=consecutive_holds+1,updated_at=?
      WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?
      RETURNING consecutive_holds`)
      .bind(new Date(now).toISOString(), lease.stream, lease.owner, new Date(now).toISOString())
      .first<{ consecutive_holds: number }>();
    if (
      row &&
      (row.consecutive_holds >= 3 ||
        reason === "budget_exhausted" ||
        reason === "attempts_exhausted" ||
        reason === "missing_boundary")
    ) {
      await this.alert(lease.stream, reason, now);
      console.error(
        JSON.stringify({
          event: "forecast_v2_stale_coverage",
          stream: lease.stream,
          reason,
          holds: row.consecutive_holds,
        }),
      );
    }
  }

  async commitPage(lease: Lease, runId: string, scan: Scan, now: number) {
    const time = new Date(now).toISOString();
    const fence = `EXISTS(SELECT 1 FROM forecast_v2_monitor_state
      WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?)`;
    const boundary = scan.status === "completed" ? nextBoundary(scan) : scan.boundary;
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
          time,
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
          time,
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
      edit_scan_completed_at=CASE WHEN ?='edit' AND ?='completed' THEN ? ELSE edit_scan_completed_at END,
      consecutive_holds=CASE WHEN ?='completed' THEN 0 ELSE consecutive_holds END,updated_at=?
      WHERE stream_id=? AND lease_owner=? AND lease_expires_at>?`)
        .bind(
          scan.kind,
          boundary.createdAt,
          scan.kind,
          JSON.stringify(boundary.feedIds),
          scan.kind,
          scan.status === "completed" ? 0 : scan.page,
          scan.kind,
          scan.status === "completed" ? 0 : scan.page,
          scan.kind,
          scan.status === "completed" ? null : scan.boundary.createdAt,
          scan.kind,
          scan.status,
          time,
          scan.status,
          time,
          lease.stream,
          lease.owner,
          time,
        ),
    );
    const results = await this.db.batch(writes);
    if (results.at(-1)?.meta.changes !== 1) throw new IngestFailure("lease_lost");
  }
}
