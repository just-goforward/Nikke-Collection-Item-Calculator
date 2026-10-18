import { hash, notification } from "./decisions";
import type { ProjectedDay, SemanticChange } from "./projection";

/**
 * Atomic projection commit. The caller supplies the active version it read:
 * the final fenced pointer insertion aborts the entire batch on a lost race.
 */
export async function persistCalendar(
  db: D1Database,
  days: readonly ProjectedDay[],
  changes: readonly SemanticChange[],
  previous: { snapshotId: string; version: number } | null,
  now: string,
): Promise<{ snapshotId: string; changed: boolean }> {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) throw new Error("calendar_days_empty");
  const contentHash = await hash(
    JSON.stringify(days.map(({ coverage: _coverage, ...day }) => day)),
  );
  const snapshotId = `calendar_${await hash(`${first.gameDay}:${last.gameDay}:${contentHash}`)}`;
  if (previous?.snapshotId === snapshotId) {
    await updateCoverage(db, first, snapshotId);
    await retainCalendar(db, now);
    return { snapshotId, changed: false };
  }
  const writes: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO forecast_v2_calendar_snapshots
      (snapshot_id,range_start,range_end,content_hash,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(snapshot_id) DO NOTHING`)
      .bind(snapshotId, first.gameDay, last.gameDay, contentHash, now),
  ];
  for (const day of days) {
    writes.push(
      db
        .prepare(`INSERT INTO forecast_v2_calendar_days(snapshot_id,game_day,payload_json)
      VALUES(?,?,?) ON CONFLICT DO NOTHING`)
        .bind(
          snapshotId,
          day.gameDay,
          JSON.stringify({
            kits: { ii: day.ii, box: day.box },
            coop: day.coop ?? 0,
            grants: day.grants.map((grant) => ({ label: grant.id, ii: grant.ii, box: grant.box })),
            pending: dayNotes(day),
            titles: Object.fromEntries(day.events.map((event) => [event.id, event.label])),
          }),
        ),
    );
    for (const event of day.events)
      writes.push(
        db
          .prepare(`INSERT INTO forecast_v2_calendar_event_links
      (snapshot_id,game_day,event_id,revision) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(snapshotId, day.gameDay, event.id, event.revision),
      );
  }
  const revision = (previous?.version ?? 0) + 1;
  // UPDATE with zero affected rows does not roll back a D1 batch. A stale
  // pointer deliberately violates the version constraint to abort all writes.
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_active(singleton,snapshot_id,version,updated_at)
    VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
    snapshot_id=excluded.snapshot_id,
    version=CASE WHEN forecast_v2_calendar_active.version=? THEN excluded.version ELSE 0 END,
    updated_at=excluded.updated_at`)
      .bind(snapshotId, revision, now, previous?.version ?? 0),
  );
  if (previous) {
    if (changes.length)
      writes.push(
        db
          .prepare(`INSERT INTO forecast_v2_calendar_diffs
      (snapshot_id,diff_key,previous_snapshot_id,payload_json) VALUES(?,?,?,?)
      ON CONFLICT DO NOTHING`)
          .bind(
            snapshotId,
            `from_${previous.snapshotId}`,
            previous.snapshotId,
            JSON.stringify(changes),
          ),
      );
    const hour = Math.floor(Date.parse(now) / 3_600_000);
    // Notification is delayed until the hourly boundary; dispatcher owns delivery.
    const key = `calendar_${hour}`;
    const pending = await db
      .prepare(`SELECT payload_json FROM forecast_v2_notification_outbox
      WHERE idempotency_key=? AND state='pending'`)
      .bind(key)
      .first<{ payload_json: string }>();
    if (changes.length || pending) {
      const priorChanges = pending
        ? (JSON.parse(pending.payload_json) as { changes: SemanticChange[] }).changes
        : [];
      const payload = {
        snapshotId,
        revision,
        adminUrl: `https://forecast-admin-staging.nikkecollection.com?rev=${revision}#gd-${first.gameDay}`,
        changes: [...priorChanges, ...changes],
      };
      writes.push(await notification(db, key, "calendar_changed", payload, now, { snapshotId }));
      const json = JSON.stringify(payload);
      writes.push(
        db
          .prepare(`UPDATE forecast_v2_notification_outbox SET
      snapshot_id=?,payload_json=?,payload_hash=?,updated_at=? WHERE idempotency_key=? AND state='pending'`)
          .bind(snapshotId, json, await hash(json), now, key),
      );
      writes.push(
        db
          .prepare(
            "UPDATE forecast_v2_notification_outbox SET next_attempt_at=? WHERE idempotency_key=? AND state='pending'",
          )
          .bind((hour + 1) * 3_600_000, key),
      );
    }
  }
  await db.batch(writes);
  await updateCoverage(db, first, snapshotId);
  await retainCalendar(db, now);
  return { snapshotId, changed: true };
}

/**
 * Coverage is an operational annotation, not calendar content. Refresh only the
 * active first day's notes in place; its identity/version/updated_at stay fixed.
 * The existing admin fixed SELECT therefore sees current coverage without a
 * schema/query change. Pending decisions remain part of the content hash.
 */
async function updateCoverage(db: D1Database, first: ProjectedDay, snapshotId: string) {
  await db
    .prepare(`UPDATE forecast_v2_calendar_days
    SET payload_json=json_set(payload_json,'$.pending',json(?))
    WHERE snapshot_id=? AND game_day=?
    AND snapshot_id=(SELECT snapshot_id FROM forecast_v2_calendar_active WHERE singleton=1)`)
    .bind(JSON.stringify(dayNotes(first)), snapshotId, first.gameDay)
    .run();
}

function dayNotes(day: ProjectedDay) {
  return [...(day.pending ?? []), ...(day.coverage ?? [])];
}

/**
 * At most ten expired snapshots per invocation, including no-change rebuilds.
 * A single atomic batch repeats the same victim set until the final DELETE.
 * Unsent means pending/sending/dead; sent receipts must be removed too because
 * their non-null calendar FK otherwise prevents deletion. Shared diffs pointing
 * back at a victim are removed, never calendar event/grant evidence.
 */
async function retainCalendar(db: D1Database, now: string) {
  const victims = `WITH expired AS (
    SELECT s.snapshot_id FROM forecast_v2_calendar_snapshots s
    WHERE julianday(s.created_at)<julianday(?,'-30 days')
    AND NOT EXISTS (SELECT 1 FROM forecast_v2_calendar_active a WHERE a.snapshot_id=s.snapshot_id)
    AND NOT EXISTS (SELECT 1 FROM forecast_v2_notification_outbox o
      WHERE o.snapshot_id=s.snapshot_id AND o.state<>'sent')
    ORDER BY s.created_at,s.snapshot_id LIMIT 10
  )`;
  await db.batch([
    db
      .prepare(`${victims} DELETE FROM forecast_v2_calendar_event_links
      WHERE snapshot_id IN (SELECT snapshot_id FROM expired)`)
      .bind(now),
    db
      .prepare(`${victims} DELETE FROM forecast_v2_calendar_days
      WHERE snapshot_id IN (SELECT snapshot_id FROM expired)`)
      .bind(now),
    db
      .prepare(`${victims} DELETE FROM forecast_v2_calendar_diffs
      WHERE snapshot_id IN (SELECT snapshot_id FROM expired)
      OR previous_snapshot_id IN (SELECT snapshot_id FROM expired)`)
      .bind(now),
    db
      .prepare(`${victims} DELETE FROM forecast_v2_notification_outbox
      WHERE state='sent' AND snapshot_id IN (SELECT snapshot_id FROM expired)`)
      .bind(now),
    db
      .prepare(`${victims} DELETE FROM forecast_v2_calendar_snapshots
      WHERE snapshot_id IN (SELECT snapshot_id FROM expired)`)
      .bind(now),
  ]);
}
