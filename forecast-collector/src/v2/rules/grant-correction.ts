/** Move only this feed's prior evidence; shared occurrences retain other feeds' links. */
export async function previousGrantOccurrences(db: D1Database, feedId: string) {
  return (
    await db
      .prepare(`SELECT DISTINCT l.occurrence_id FROM forecast_v2_grant_links l
    JOIN forecast_v2_grant_observations o USING(observation_id)
    JOIN forecast_v2_grant_heads h USING(occurrence_id) WHERE o.feed_id=?`)
      .bind(feedId)
      .all<{ occurrence_id: string }>()
  ).results;
}

export function unlinkPreviousGrant(
  db: D1Database,
  feedId: string,
  target: string,
  previous: readonly { occurrence_id: string }[],
): D1PreparedStatement[] {
  return previous
    .filter((row) => row.occurrence_id !== target)
    .flatMap((row) => [
      db
        .prepare(`DELETE FROM forecast_v2_grant_links WHERE occurrence_id=? AND observation_id IN(
      SELECT observation_id FROM forecast_v2_grant_observations WHERE feed_id=?)`)
        .bind(row.occurrence_id, feedId),
      db
        .prepare(`DELETE FROM forecast_v2_grant_heads WHERE occurrence_id=? AND NOT EXISTS(
      SELECT 1 FROM forecast_v2_grant_links WHERE occurrence_id=?)`)
        .bind(row.occurrence_id, row.occurrence_id),
    ]);
}
