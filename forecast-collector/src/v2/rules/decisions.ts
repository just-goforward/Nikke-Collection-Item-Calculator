import {
  type ForecastV2NotificationKind,
  type ForecastV2Payloads,
  validateForecastV2Payload,
} from "../../../../shared/forecastV2Notifications";
import { DAY_MS } from "./game-day";

export async function hash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function decisionIdentity(...parts: (string | number)[]): Promise<string> {
  return `d_${(await hash(JSON.stringify(parts))).slice(0, 24)}`;
}

export async function notification<K extends ForecastV2NotificationKind>(
  db: D1Database,
  key: string,
  kind: K,
  payload: ForecastV2Payloads[K],
  now: string,
  references: { decisionId?: string; snapshotId?: string },
): Promise<D1PreparedStatement> {
  if (!validateForecastV2Payload(kind, payload)) throw new Error(`Invalid ${kind} payload`);
  const json = JSON.stringify(payload);
  return db
    .prepare(`INSERT INTO forecast_v2_notification_outbox
    (outbox_id,idempotency_key,kind,snapshot_id,decision_id,channel_role,payload_json,payload_hash,
    next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(idempotency_key) DO NOTHING`)
    .bind(
      key,
      key,
      kind,
      references.snapshotId ?? null,
      references.decisionId ?? null,
      kind === "calendar_changed" ? "activity" : "approval",
      json,
      await hash(json),
      Date.parse(now),
      now,
      now,
    );
}

export type DecisionInput = {
  id: string;
  type: ForecastV2Payloads["decision_request"]["type"];
  environment: "staging" | "production";
  eventId: string | null;
  sourceHash: string;
  sourceVersion?: string;
  feedIds: number[];
  title: string;
  url: string;
  options: {
    id: string;
    label: string;
    startAt?: string;
    endAt?: string;
    eventId?: string;
    expectedRevision?: number;
  }[];
  suppressNotification?: boolean;
  extracted?: {
    complete?: boolean;
    startAt?: string;
    endAt?: string;
    segments?: ForecastV2Payloads["b_report"]["extracted"]["segments"];
    kits?: ForecastV2Payloads["b_report"]["extracted"]["kits"];
  };
};

/** Persist request and notification together; replay never resets expiry. */
export async function requestDecision(
  db: D1Database,
  input: DecisionInput,
  now: string,
): Promise<void> {
  const head = input.eventId
    ? await db
        .prepare("SELECT revision FROM forecast_v2_calendar_heads WHERE event_id=?")
        .bind(input.eventId)
        .first<{ revision: number }>()
    : null;
  const expiresAt = new Date(Date.parse(now) + 14 * DAY_MS).toISOString();
  const source = await db
    .prepare(`SELECT version_id FROM forecast_v2_post_versions
    WHERE feed_id=? AND content_hash=?
    ORDER BY julianday(updated_date) DESC,julianday(fetched_at) DESC,version_id DESC LIMIT 1`)
    .bind(String(input.feedIds[0]), input.sourceHash)
    .first<{ version_id: string }>();
  const payload = {
    env: input.environment,
    eventId: input.eventId,
    sourceHash: input.sourceHash,
    sourceVersion: input.sourceVersion ?? source?.version_id ?? null,
    feedIds: input.feedIds,
    title: input.title,
    url: input.url,
    options: input.options,
    ...decisionExtraction(input),
  };
  const json = JSON.stringify(payload);
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_decision_requests
      (decision_id,type,event_id,payload_json,payload_hash,expected_calendar_revision,expires_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(decision_id) DO NOTHING`)
      .bind(
        input.id,
        input.type,
        input.eventId,
        json,
        await hash(json),
        head?.revision ?? 0,
        expiresAt,
        now,
      ),
    ...(input.suppressNotification
      ? []
      : [
          await notification(
            db,
            `decision_${input.id}`,
            "decision_request",
            {
              decisionRequestId: input.id,
              type: input.type,
              feedIds: input.feedIds,
              title: input.title,
              url: input.url,
              options: input.options,
              expiresAt,
            },
            now,
            { decisionId: input.id },
          ),
        ]),
  ]);
}

function decisionExtraction(input: DecisionInput) {
  if (input.type === "solo_review") {
    const { startAt, endAt } = input.extracted ?? {};
    return {
      extracted: {
        ...input.extracted,
        complete: Boolean(startAt && endAt && Date.parse(endAt) > Date.parse(startAt)),
      },
    };
  }
  return input.extracted ? { extracted: input.extracted } : {};
}

/** One bounded lifecycle unit; subsequent invocations drain any remaining reminders. */
export async function maintainDecisions(db: D1Database, now: string): Promise<void> {
  await refreshRevisionDecision(db, now);
  await db
    .prepare(`UPDATE forecast_v2_decision_requests SET status='expired'
    WHERE status='pending' AND julianday(expires_at)<=julianday(?)`)
    .bind(now)
    .run();
  const cutoff = new Date(Date.parse(now) - 3 * DAY_MS).toISOString();
  const row = await db
    .prepare(`SELECT decision_id FROM forecast_v2_decision_requests
    WHERE status='pending' AND reminder_sent_at IS NULL AND julianday(created_at)<=julianday(?)
    AND julianday(expires_at)>julianday(?) ORDER BY created_at,decision_id LIMIT 1`)
    .bind(cutoff, now)
    .first<{ decision_id: string }>();
  if (!row) return;
  await db.batch([
    await notification(
      db,
      `reminder_${row.decision_id}`,
      "decision_reminder",
      {
        decisionRequestId: row.decision_id,
      },
      now,
      { decisionId: row.decision_id },
    ),
    db
      .prepare(`UPDATE forecast_v2_decision_requests SET reminder_sent_at=?
      WHERE decision_id=? AND reminder_sent_at IS NULL AND status='pending'`)
      .bind(now, row.decision_id),
  ]);
}

export async function refreshRevisionDecision(db: D1Database, now: string) {
  const rows = await db
    .prepare(`SELECT q.decision_id,q.type,q.event_id,q.payload_json,h.revision
    FROM forecast_v2_decision_requests q JOIN forecast_v2_calendar_heads h USING(event_id)
    WHERE q.status='pending' AND q.expected_calendar_revision<>h.revision
    AND (json_extract(q.payload_json,'$.sourceVersion') IS NULL OR
      json_extract(q.payload_json,'$.sourceVersion')=(
        SELECT version_id FROM forecast_v2_post_versions
        WHERE feed_id=CAST(json_extract(q.payload_json,'$.feedIds[0]') AS TEXT)
        ORDER BY julianday(updated_date) DESC,julianday(fetched_at) DESC,version_id DESC LIMIT 1))
    ORDER BY q.created_at,q.decision_id LIMIT 16`)
    .all<{
      decision_id: string;
      type: DecisionInput["type"];
      event_id: string;
      payload_json: string;
      revision: number;
    }>();
  for (const row of rows.results) {
    const payload = JSON.parse(row.payload_json) as {
      env: DecisionInput["environment"];
      sourceHash: string;
      feedIds: number[];
      sourceVersion?: string;
      title: string;
      url: string;
      options: DecisionInput["options"];
      extracted?: DecisionInput["extracted"];
    };
    await requestDecision(
      db,
      {
        id: await decisionIdentity("revision", row.decision_id, row.revision),
        type: row.type,
        eventId: row.event_id,
        environment: payload.env,
        sourceHash: payload.sourceHash,
        feedIds: payload.feedIds,
        ...(payload.sourceVersion ? { sourceVersion: payload.sourceVersion } : {}),
        title: payload.title,
        url: payload.url,
        options: payload.options,
        ...(payload.extracted ? { extracted: payload.extracted } : {}),
      },
      now,
    );
    await db
      .prepare("UPDATE forecast_v2_decision_requests SET status='stale' WHERE decision_id=?")
      .bind(row.decision_id)
      .run();
  }
}

/** E remains due hourly until review resolution/expiry; ingest owns run scheduling. */
export async function dueEFollowUps(db: D1Database, now: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM forecast_v2_decision_requests
    WHERE type='solo_review' AND status='pending' AND julianday(expires_at)>julianday(?)`)
    .bind(now)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
