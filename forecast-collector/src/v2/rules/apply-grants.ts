import { hash } from "./decisions";
import { gameDay } from "./game-day";
import { previousGrantOccurrences, unlinkPreviousGrant } from "./grant-correction";
import { applySourceFencedBatch, rejectStaleSource } from "./source-fence";

export async function applyGrantDecision(db: D1Database, now: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT q.decision_id,q.type,q.payload_json,r.result_json
    FROM forecast_v2_decision_requests q JOIN forecast_v2_decision_results r ON r.decision_id=q.decision_id
    WHERE q.status='resolved' AND q.type IN ('grant_date','grant_quantity')
    AND NOT EXISTS(SELECT 1 FROM forecast_v2_admin_commands c WHERE c.decision_id=q.decision_id)
    ORDER BY r.created_at,r.decision_id LIMIT 1`)
    .first<{
      decision_id: string;
      type: string;
      payload_json: string;
      result_json: string;
    }>();
  if (!row) return false;
  const payload = JSON.parse(row.payload_json) as {
    feedIds: number[];
    sourceHash: string;
    options: { id: string; label: string }[];
    extracted?: { startAt?: string };
  };
  const result = JSON.parse(row.result_json) as { action: string; optionId: string };
  if (await rejectStaleSource(db, row.decision_id, payload)) return false;
  const option = payload.options.find((value) => value.id === result.optionId);
  if (result.action !== "opt" || !option) throw new Error("grant_decision_option_invalid");
  const observation = await db
    .prepare(`SELECT o.* FROM forecast_v2_grant_observations o
    JOIN forecast_v2_post_versions v ON v.version_id=o.version_id
    WHERE o.feed_id=? AND v.content_hash=? ORDER BY o.created_at DESC LIMIT 1`)
    .bind(String(payload.feedIds[0]), payload.sourceHash)
    .first<{
      observation_id: string;
      ii_qty: number;
      box_qty: number;
      candidate_dates_json: string;
    }>();
  if (!observation) throw new Error("grant_decision_observation_missing");
  const date = selectedGrantDate(
    row.type,
    option.label,
    payload.extracted?.startAt,
    observation.candidate_dates_json,
  );
  const current = await db
    .prepare(`SELECT occurrence_id,revision FROM forecast_v2_grant_heads
    WHERE grant_game_day=? AND ii_qty=? AND box_qty=?`)
    .bind(date, observation.ii_qty, observation.box_qty)
    .first<{ occurrence_id: string; revision: number }>();
  return persistGrantDecision(
    db,
    now,
    row,
    observation,
    date,
    current,
    option.id,
    String(payload.feedIds[0]),
  );
}

function selectedGrantDate(
  type: string,
  label: string,
  extractedStart: string | undefined,
  candidateDates: string,
) {
  const candidates = JSON.parse(candidateDates) as (
    | string
    | { instant: string | null; date: string }
  )[];
  const first = candidates[0];
  const value =
    type === "grant_date"
      ? label
      : (extractedStart ?? (typeof first === "string" ? first : (first?.instant ?? first?.date)));
  if (!value) throw new Error("grant_decision_date_missing");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : gameDay(value);
}

async function persistGrantDecision(
  db: D1Database,
  now: string,
  row: { decision_id: string; result_json: string },
  observation: { observation_id: string; ii_qty: number; box_qty: number },
  date: string,
  current: { occurrence_id: string; revision: number } | null,
  optionId: string,
  feedId: string,
) {
  const previous = await previousGrantOccurrences(db, feedId);
  if (previous.length > 1) throw new Error("grant_correction_target_ambiguous");
  const corrected =
    !current && optionId === "correction"
      ? await db
          .prepare(
            "SELECT occurrence_id,revision FROM forecast_v2_grant_heads WHERE grant_game_day=?",
          )
          .bind(date)
          .all<{ occurrence_id: string; revision: number }>()
      : null;
  if (corrected && corrected.results.length !== 1)
    throw new Error("grant_correction_target_ambiguous");
  const target = current ?? corrected?.results[0];
  const id = target?.occurrence_id ?? `grant_${date}_${observation.ii_qty}_${observation.box_qty}`;
  const revision = current ? current.revision : (target?.revision ?? 0) + 1;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO forecast_v2_admin_commands
      (command_id,idempotency_key,payload_hash,event_id,decision_id,expected_revision,created_at)
      VALUES(?,?,?,NULL,?,0,?)`)
      .bind(
        `apply_${row.decision_id}`,
        row.decision_id,
        await hash(row.result_json),
        row.decision_id,
        now,
      ),
  ];
  if (!current) {
    statements.push(
      db
        .prepare(`INSERT INTO forecast_v2_grant_revisions
      (occurrence_id,revision,grant_game_day,ii_qty,box_qty,decision_id,created_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(id, revision, date, observation.ii_qty, observation.box_qty, row.decision_id, now),
    );
    statements.push(
      db
        .prepare(`INSERT INTO forecast_v2_grant_heads VALUES(?,?,?,?,?)
      ON CONFLICT(occurrence_id) DO UPDATE SET revision=excluded.revision,grant_game_day=excluded.grant_game_day,
      ii_qty=excluded.ii_qty,box_qty=excluded.box_qty`)
        .bind(id, revision, date, observation.ii_qty, observation.box_qty),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO forecast_v2_grant_links(link_id,occurrence_id,observation_id)
    VALUES(?,?,?) ON CONFLICT DO NOTHING`)
      .bind(`${id}_${observation.observation_id}`, id, observation.observation_id),
  );
  statements.push(...unlinkPreviousGrant(db, feedId, id, previous));
  if (!(await applySourceFencedBatch(db, row.decision_id, statements))) return false;
  return !current;
}
