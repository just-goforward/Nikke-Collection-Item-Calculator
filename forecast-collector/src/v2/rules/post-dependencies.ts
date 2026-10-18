import { extractNoticeText } from "../../solo-sections";
import type { ExistingWindow } from "./identity";
import { noticeDates } from "./notice-dates";
import type { Notice } from "./schedules";
import { soloRound } from "./solo-identity";

export async function postDependencies(db: D1Database, feedId: string, post: Notice) {
  const dates = noticeDates(extractNoticeText(post.body).effective, post.postedAt).map(
    (value) => value.date,
  );
  dates.push(new Date(Date.parse(post.postedAt) + 9 * 3600000).toISOString().slice(0, 10));
  dates.sort();
  return db
    .prepare(`SELECT h.event_id id,r.starts_at startAt,r.ends_at endAt,r.kind,h.revision,
    r.prediction_provenance_json provenance
    FROM forecast_v2_calendar_heads h JOIN forecast_v2_calendar_revisions r
    ON r.event_id=h.event_id AND r.revision=h.revision WHERE r.status='confirmed' AND (
      EXISTS(SELECT 1 FROM json_each(r.source_feed_ids_json) WHERE CAST(value AS TEXT)=?)
      OR (r.kind IN ('maintenance','collaboration','solo')
        AND julianday(r.ends_at)>=julianday(?) AND julianday(r.starts_at)<=julianday(?))
      OR (r.kind='solo' AND json_extract(r.prediction_provenance_json,'$.round')=?))`)
    .bind(
      feedId,
      `${dates[0]}T00:00:00+09:00`,
      `${dates.at(-1)}T23:59:59+09:00`,
      soloRound(post.title, post.body, feedId),
    )
    .all<ExistingWindow & { kind: string; revision: number; provenance: string | null }>();
}
