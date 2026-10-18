import { type DecisionInput, decisionIdentity, requestDecision } from "./decisions";
import { grantDateCandidates } from "./notice-dates";
import { collaborationOptions, windowOptions } from "./schedule-options";
import { judgeMaintenance } from "./schedules";

export async function rejectStaleSource(
  db: D1Database,
  decisionId: string,
  payload: { feedIds: number[]; sourceHash: string; sourceVersion?: string | null },
): Promise<boolean> {
  const current = await db
    .prepare(`SELECT content_hash,version_id FROM forecast_v2_post_versions
    WHERE feed_id=? ORDER BY julianday(updated_date) DESC,julianday(fetched_at) DESC,version_id DESC LIMIT 1`)
    .bind(String(payload.feedIds[0]))
    .first<{ content_hash: string; version_id: string }>();
  if (!current) return false;
  const version = payload.sourceVersion;
  const matches = version
    ? current.version_id === version
    : current.content_hash === payload.sourceHash;
  if (matches) return false;
  await replaceStaleRequest(db, decisionId, current);
  await db
    .prepare("UPDATE forecast_v2_decision_requests SET status='stale' WHERE decision_id=?")
    .bind(decisionId)
    .run();
  return true;
}

async function replaceStaleRequest(
  db: D1Database,
  decisionId: string,
  current: { content_hash: string; version_id: string },
) {
  const row = await db
    .prepare(`SELECT type,event_id,payload_json FROM forecast_v2_decision_requests
    WHERE decision_id=?`)
    .bind(decisionId)
    .first<{
      type: DecisionInput["type"];
      event_id: string | null;
      payload_json: string;
    }>();
  if (!row) return;
  const payload = JSON.parse(row.payload_json) as {
    env: DecisionInput["environment"];
    feedIds: number[];
    title: string;
    url: string;
  };
  const source = await db
    .prepare(
      "SELECT fetched_at,created_at,body_text FROM forecast_v2_post_versions WHERE version_id=?",
    )
    .bind(current.version_id)
    .first<{ fetched_at: string; created_at: string; body_text: string }>();
  // Never relabel extracted schedules/options from an obsolete body as current evidence.
  await requestDecision(
    db,
    {
      id: await decisionIdentity(payload.feedIds[0]!, current.version_id, row.type),
      type: row.type,
      eventId: row.event_id,
      environment: payload.env,
      sourceHash: current.content_hash,
      sourceVersion: current.version_id,
      feedIds: payload.feedIds,
      title: payload.title,
      url: payload.url,
      options: replacementOptions(row.type, payload.title, source!.body_text, source!.created_at),
    },
    source!.fetched_at,
  );
}

function replacementOptions(
  type: DecisionInput["type"],
  title: string,
  body: string,
  postedAt: string,
) {
  if (type === "solo_review") return [];
  if (type === "grant_date" || type === "grant_quantity")
    return grantDateCandidates(body, postedAt).map((date, index) => ({
      id: `date_${index}`,
      label: date.instant ?? date.date,
    }));
  const post = { title, body, postedAt };
  const maintenance = judgeMaintenance(post);
  const candidates =
    type === "collaboration"
      ? collaborationOptions(post, [])
      : maintenance.action === "confirmed"
        ? windowOptions([maintenance])
        : [];
  return [...candidates, { id: "ignore", label: "관련 없음" }];
}

/** D1 batches are transactions: a failed assertion rolls back every dependent write. */
export async function applySourceFencedBatch(
  db: D1Database,
  decisionId: string,
  writes: D1PreparedStatement[],
): Promise<boolean> {
  const guard = db
    .prepare(`SELECT json(CASE WHEN NOT EXISTS (
    SELECT 1 FROM forecast_v2_decision_requests q
    JOIN forecast_v2_post_versions v ON v.version_id=(
      SELECT version_id FROM forecast_v2_post_versions
      WHERE feed_id=CAST(json_extract(q.payload_json,'$.feedIds[0]') AS TEXT)
      ORDER BY julianday(updated_date) DESC,julianday(fetched_at) DESC,version_id DESC LIMIT 1)
    WHERE q.decision_id=? AND CASE
      WHEN json_extract(q.payload_json,'$.sourceVersion') IS NOT NULL
      THEN v.version_id<>json_extract(q.payload_json,'$.sourceVersion')
      ELSE v.content_hash<>json_extract(q.payload_json,'$.sourceHash') END
    ) THEN '{}' ELSE 'source_version_changed' END)`)
    .bind(decisionId);
  try {
    await db.batch([guard, ...writes]);
    return true;
  } catch (error) {
    const row = await db
      .prepare("SELECT payload_json FROM forecast_v2_decision_requests WHERE decision_id=?")
      .bind(decisionId)
      .first<{ payload_json: string }>();
    if (row && (await rejectStaleSource(db, decisionId, JSON.parse(row.payload_json))))
      return false;
    throw error;
  }
}
