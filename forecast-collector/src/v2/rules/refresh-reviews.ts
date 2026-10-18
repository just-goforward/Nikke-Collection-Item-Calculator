import { judgeCollaboration } from "./collaboration";
import { type DecisionInput, decisionIdentity, requestDecision } from "./decisions";
import { judgeMaintenance, judgeSolo } from "./schedules";

/** Resolve missing G evidence into a fresh, revision-bound admin choice. */
export async function refreshMaintenanceReviews(db: D1Database, now: string): Promise<void> {
  const requests = await db
    .prepare(`SELECT q.decision_id,q.type,q.event_id,q.payload_json,v.body_text,v.created_at
    FROM forecast_v2_decision_requests q JOIN forecast_v2_post_versions v
    ON v.feed_id=CAST(json_extract(q.payload_json,'$.feedIds[0]') AS TEXT)
    AND v.content_hash=json_extract(q.payload_json,'$.sourceHash')
    WHERE q.status='pending' AND q.type IN ('solo_review','collaboration','maintenance')
    AND json_extract(q.payload_json,'$.extracted.startAt') IS NULL
    AND julianday(q.expires_at)>julianday(?) ORDER BY q.created_at`)
    .bind(now)
    .all<{
      decision_id: string;
      type: "solo_review" | "collaboration" | "maintenance";
      event_id: string | null;
      payload_json: string;
      body_text: string;
      created_at: string;
    }>();
  if (!requests.results.length) return;
  const maintenance = (
    await db
      .prepare(`SELECT h.event_id id,r.starts_at startAt,r.ends_at endAt
    FROM forecast_v2_calendar_heads h JOIN forecast_v2_calendar_revisions r
    ON r.event_id=h.event_id AND r.revision=h.revision WHERE r.kind='maintenance' AND r.status='confirmed'
    AND julianday(r.ends_at)>=julianday(?,'-60 days')
    AND julianday(r.starts_at)<=julianday(?,'+1 month')`)
      .bind(now, now)
      .all<{ id: string; startAt: string; endAt: string }>()
  ).results;
  for (const request of requests.results) {
    const payload = JSON.parse(request.payload_json) as {
      env: DecisionInput["environment"];
      sourceHash: string;
      sourceVersion?: string;
      feedIds: number[];
      title: string;
      url: string;
    };
    const post = { title: payload.title, body: request.body_text, postedAt: request.created_at };
    const judgment =
      request.type === "solo_review"
        ? judgeSolo(post, maintenance)
        : request.type === "maintenance"
          ? judgeMaintenance(post)
          : judgeCollaboration(post, maintenance, []);
    if (judgment.action !== "confirmed" && judgment.action !== "create") continue;
    const id = await decisionIdentity(
      "refreshed",
      request.decision_id,
      judgment.startAt,
      judgment.endAt,
    );
    await requestDecision(
      db,
      {
        id,
        type: request.type,
        environment: payload.env,
        eventId: request.event_id,
        sourceHash: payload.sourceHash,
        ...(payload.sourceVersion ? { sourceVersion: payload.sourceVersion } : {}),
        feedIds: payload.feedIds,
        title: payload.title,
        url: payload.url,
        options:
          request.type === "solo_review"
            ? []
            : request.type === "maintenance"
              ? [
                  { id: "use_source", label: "점검 일시 확인" },
                  { id: "ignore", label: "관련 없음" },
                ]
              : [
                  { id: "new", label: "새 콜라보" },
                  { id: "same", label: "기존 콜라보" },
                  { id: "ignore", label: "관련 없음" },
                ],
        extracted: { startAt: judgment.startAt, endAt: judgment.endAt },
      },
      now,
    );
    await db
      .prepare(
        "UPDATE forecast_v2_decision_requests SET status='stale' WHERE decision_id=? AND status='pending'",
      )
      .bind(request.decision_id)
      .run();
    // One review mutation per invocation; durable pending requests retain the remainder.
    return;
  }
}
