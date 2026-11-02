import type { DecisionInput } from "./decisions";
import { gameDay } from "./game-day";

export function decisionPeriod(startAt: string | undefined, endAt: string | undefined) {
  if (
    !startAt ||
    !endAt ||
    !Number.isFinite(Date.parse(startAt)) ||
    !Number.isFinite(Date.parse(endAt)) ||
    Date.parse(endAt) <= Date.parse(startAt)
  )
    throw new Error("decision_schedule_missing");
  return { start: new Date(startAt).toISOString(), end: new Date(endAt).toISOString() };
}

export async function truncateSeason(
  db: D1Database,
  provenance: string,
  start: string,
  now: string,
) {
  const writes: D1PreparedStatement[] = [];
  const round = (JSON.parse(provenance) as { round?: number }).round;
  if (!round) return writes;
  const overlapping = await db
    .prepare(`SELECT r.* FROM forecast_v2_calendar_heads h
          JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision
          WHERE r.kind='solo' AND r.status='confirmed' AND json_extract(r.prediction_provenance_json,'$.round')=?
          AND julianday(r.starts_at)<julianday(?) AND julianday(r.ends_at)>julianday(?)`)
    .bind(round, start, start)
    .all<{ event_id: string; revision: number }>();
  for (const previous of overlapping.results) {
    writes.push(
      db
        .prepare(`INSERT INTO forecast_v2_calendar_revisions
            SELECT event_id,revision+1,kind,status,starts_at,?,start_game_day,?,
            maintenance_event_id,maintenance_revision,prediction_provenance_json,source_feed_ids_json,?
            FROM forecast_v2_calendar_revisions WHERE event_id=? AND revision=?`)
        .bind(start, gameDay(start), now, previous.event_id, previous.revision),
    );
    writes.push(
      db
        .prepare(
          "UPDATE forecast_v2_calendar_heads SET revision=revision+1 WHERE event_id=? AND revision=?",
        )
        .bind(previous.event_id, previous.revision),
    );
  }
  return writes;
}

export function resumeWindow(
  db: D1Database,
  decisionId: string,
  extracted: DecisionInput["extracted"],
  end: string,
  provenance: string | null | undefined,
  feedIds: number[],
  now: string,
) {
  const writes: D1PreparedStatement[] = [];
  const segments = extracted?.segments ?? [];
  const suspension = segments.find(
    (segment) => segment.kind === "suspend" && segment.startAt && segment.endAt,
  );
  const extension = segments.find((segment) => segment.kind === "extend" && segment.endAt);
  const resumeStart = extension?.startAt ?? suspension?.endAt;
  const resumeEnd = extension?.endAt;
  if (
    !(
      resumeStart &&
      resumeEnd &&
      Date.parse(resumeEnd) > Date.parse(resumeStart) &&
      Date.parse(resumeStart) >= Date.parse(end)
    )
  )
    return writes;
  const metadata = provenance
    ? (JSON.parse(provenance) as { round?: number; segment?: number })
    : {};
  const resumeId = `resume_${decisionId}`;
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
          (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,
          source_feed_ids_json,created_at,prediction_provenance_json) VALUES(?,1,'solo','confirmed',?,?,?,?,?,?,?)`)
      .bind(
        resumeId,
        new Date(resumeStart).toISOString(),
        new Date(resumeEnd).toISOString(),
        gameDay(resumeStart),
        gameDay(resumeEnd),
        JSON.stringify(feedIds),
        now,
        JSON.stringify({ ...metadata, segment: (metadata.segment ?? 1) + 1 }),
      ),
  );
  writes.push(db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)").bind(resumeId));
  return writes;
}
