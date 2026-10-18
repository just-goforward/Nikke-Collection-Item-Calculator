import { gameDayStartMs } from "../../../../shared/gameDay";
import { SOLO_RAID_ROUND_HISTORY, type SoloRaidRound } from "../../../../shared/soloRaidCadence";

export function cadenceAnchor(history: readonly SoloRaidRound[]) {
  return history.at(-1)?.round ?? SOLO_RAID_ROUND_HISTORY.at(-1)!.round;
}

/** Compact cadence dependencies: one initial start per season, never post bodies. */
export async function readCadenceHistory(db: D1Database, until: string): Promise<SoloRaidRound[]> {
  const rows = await db
    .prepare(`SELECT json_extract(r.prediction_provenance_json,'$.round') AS round,
    MIN(julianday(r.starts_at)) AS start
    FROM forecast_v2_calendar_heads h JOIN forecast_v2_calendar_revisions r USING(event_id,revision)
    WHERE r.kind='solo' AND r.status='confirmed' AND r.starts_at IS NOT NULL
      AND julianday(r.starts_at)<julianday(?)
      AND json_extract(r.prediction_provenance_json,'$.round')>?
    GROUP BY json_extract(r.prediction_provenance_json,'$.round') ORDER BY round`)
    .bind(until, SOLO_RAID_ROUND_HISTORY.at(-1)!.round)
    .all<{ round: number; start: number }>();
  return rows.results.map((row) => ({
    round: row.round,
    startGameDate: new Date(
      gameDayStartMs(Math.round((row.start - 2440587.5) * 86400000)) + 9 * 3600000,
    )
      .toISOString()
      .slice(0, 10),
    status: "as_announced",
    sourceFeedId: 0,
  }));
}
