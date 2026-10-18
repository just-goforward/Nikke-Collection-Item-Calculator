import {
  type DecisionInput,
  decisionIdentity,
  hash,
  refreshRevisionDecision,
  requestDecision,
} from "./decisions";
import { gameDay } from "./game-day";
import { maintenanceDependents } from "./maintenance-dependents";
import { decisionPeriod, resumeWindow, truncateSeason } from "./schedule-writes";
import { soloRound } from "./solo-identity";
import { applySourceFencedBatch, rejectStaleSource } from "./source-fence";

type PendingResult = {
  decision_id: string;
  event_id: string | null;
  expected_calendar_revision: number;
  payload_json: string;
  result_json: string;
  type: DecisionInput["type"];
};
type Payload = {
  env: DecisionInput["environment"];
  sourceHash: string;
  sourceVersion?: string;
  feedIds: number[];
  title: string;
  url: string;
  options: DecisionInput["options"];
  extracted?: DecisionInput["extracted"];
};
type Result = { action: "bok" | "bno" | "edit" | "opt"; startAt?: string; endAt?: string };
type Head = {
  revision: number;
  kind: string;
  provenance: string | null;
  feedIds: string;
  endAt: string;
};

/** Applies one immutable result per bounded invocation. */
export async function applyScheduleDecision(db: D1Database, now: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT r.decision_id,q.event_id,q.expected_calendar_revision,
    q.payload_json,r.result_json,q.type FROM forecast_v2_decision_results r
    JOIN forecast_v2_decision_requests q ON q.decision_id=r.decision_id
    WHERE q.status='resolved' AND q.type IN ('solo_review','maintenance','collaboration')
    AND NOT EXISTS(SELECT 1 FROM forecast_v2_admin_commands c WHERE c.decision_id=r.decision_id)
    ORDER BY r.created_at,r.decision_id LIMIT 1`)
    .first<PendingResult>();
  if (!row) return false;
  const payload = JSON.parse(row.payload_json) as Payload;
  if (await rejectStaleSource(db, row.decision_id, payload)) return false;
  const result = JSON.parse(row.result_json) as Result;
  selectMaintenanceTarget(row, payload);
  const head = row.event_id
    ? await db
        .prepare(`SELECT h.revision,r.kind,r.prediction_provenance_json provenance,
    r.source_feed_ids_json feedIds,r.ends_at endAt
    FROM forecast_v2_calendar_heads h JOIN forecast_v2_calendar_revisions r
    ON r.event_id=h.event_id AND r.revision=h.revision WHERE h.event_id=?`)
        .bind(row.event_id)
        .first<Head>()
    : null;
  if ((head?.revision ?? 0) !== row.expected_calendar_revision) {
    await supersedeDecision(db, row, payload, head, now);
    return false;
  }
  resolveOption(row, payload, result);
  return commitDecision(db, row, payload, result, head, now);
}

function selectMaintenanceTarget(row: PendingResult, payload: Payload) {
  if (row.type !== "maintenance") return;
  const result = JSON.parse(row.result_json) as { action: string; optionId?: string };
  if (result.action !== "opt") return;
  const option = payload.options.find((value) => value.id === result.optionId);
  if (!option?.eventId || option.expectedRevision === undefined) return;
  row.event_id = option.eventId;
  row.expected_calendar_revision = option.expectedRevision;
}

async function supersedeDecision(
  db: D1Database,
  row: PendingResult,
  payload: Payload,
  head: Head | null,
  now: string,
) {
  await requestDecision(
    db,
    {
      id: await decisionIdentity("retry", row.decision_id, head?.revision ?? 0),
      type: row.type,
      environment: payload.env,
      eventId: row.event_id,
      sourceHash: payload.sourceHash,
      ...(payload.sourceVersion ? { sourceVersion: payload.sourceVersion } : {}),
      feedIds: payload.feedIds,
      title: payload.title,
      url: payload.url,
      options: payload.options,
      ...(payload.extracted ? { extracted: payload.extracted } : {}),
    },
    now,
  );
  await db
    .prepare(
      "UPDATE forecast_v2_decision_requests SET status='stale' WHERE decision_id=? AND status='resolved'",
    )
    .bind(row.decision_id)
    .run();
}

function resolveOption(row: PendingResult, payload: Payload, result: Result) {
  if (result.action === "opt") {
    const selected = JSON.parse(row.result_json) as { optionId: string };
    const option = payload.options.find((option) => option.id === selected.optionId);
    if (!option) throw new Error("schedule_decision_option_invalid");
    if (option.startAt && option.endAt) {
      result.action = "edit";
      result.startAt = option.startAt;
      result.endAt = option.endAt;
      return;
    }
    if (selected.optionId === "ignore" || selected.optionId === "same") result.action = "bno";
    else if (selected.optionId === "use_source" || selected.optionId === "new")
      result.action = "bok";
    else throw new Error("schedule_decision_option_unsupported");
  }
}

async function commitDecision(
  db: D1Database,
  row: PendingResult,
  payload: Payload,
  result: Result,
  head: Head | null,
  now: string,
) {
  const eventId = row.event_id ?? `decision_${row.decision_id}`;
  const revision = (head?.revision ?? 0) + 1;
  const startAt = result.action === "edit" ? result.startAt : payload.extracted?.startAt;
  const endAt = result.action === "edit" ? result.endAt : payload.extracted?.endAt;
  const writes: D1PreparedStatement[] = [];
  const source =
    !head && row.type === "solo_review"
      ? await db
          .prepare(
            "SELECT body_text FROM forecast_v2_post_versions WHERE feed_id=? AND content_hash=? LIMIT 1",
          )
          .bind(String(payload.feedIds[0]), payload.sourceHash)
          .first<{ body_text: string }>()
      : null;
  const provenance =
    head?.provenance ??
    (source
      ? JSON.stringify({
          round: soloRound(payload.title, source.body_text, String(payload.feedIds[0])),
          segment: 1,
        })
      : null);
  // The marker precedes head advancement so its CAS checks the expected old revision.
  // A replay cannot pass its UNIQUE decision_id constraint, and D1 rolls back the batch.
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_admin_commands
    (command_id,idempotency_key,payload_hash,event_id,decision_id,expected_revision,created_at)
    VALUES(?,?,?,?,?,?,?)`)
      .bind(
        `apply_${row.decision_id}`,
        row.decision_id,
        await hash(row.result_json),
        row.event_id,
        row.decision_id,
        row.expected_calendar_revision,
        now,
      ),
  );
  if (result.action !== "bno") {
    writes.push(
      ...(await acceptedSchedule(db, row, payload, result, head, now, {
        eventId,
        revision,
        startAt,
        endAt,
        provenance,
      })),
    );
  }
  if (!(await applySourceFencedBatch(db, row.decision_id, writes))) return false;
  await refreshRevisionDecision(db, now);
  return result.action !== "bno";
}

async function acceptedSchedule(
  db: D1Database,
  row: PendingResult,
  payload: Payload,
  result: Result,
  head: Head | null,
  now: string,
  input: {
    eventId: string;
    revision: number;
    startAt: string | undefined;
    endAt: string | undefined;
    provenance: string | null;
  },
) {
  const { eventId, revision, startAt, endAt, provenance } = input;
  const writes: D1PreparedStatement[] = [];
  const { start, end } = decisionPeriod(startAt, endAt);
  if (!head && row.type === "solo_review" && provenance) {
    writes.push(...(await truncateSeason(db, provenance, start, now)));
  }
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,source_feed_ids_json,created_at,prediction_provenance_json)
      VALUES(?,?,?,'confirmed',?,?,?,?,?,?,?)`)
      .bind(
        eventId,
        revision,
        head?.kind ?? (row.type === "solo_review" ? "solo" : row.type),
        start,
        end,
        gameDay(start),
        gameDay(end),
        JSON.stringify([
          ...new Set([...(head ? (JSON.parse(head.feedIds) as number[]) : []), ...payload.feedIds]),
        ]),
        now,
        provenance,
      ),
  );
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_heads(event_id,revision) VALUES(?,?)
      ON CONFLICT(event_id) DO UPDATE SET revision=excluded.revision`)
      .bind(eventId, revision),
  );
  if (head?.kind === "maintenance" && head.endAt !== end)
    writes.push(
      ...(await maintenanceDependents(db, eventId, revision, head.endAt, end, now, payload.env)),
    );
  if (row.type === "solo_review" && result.action === "bok") {
    writes.push(
      ...resumeWindow(
        db,
        row.decision_id,
        payload.extracted,
        end,
        head?.provenance,
        payload.feedIds,
        now,
      ),
    );
  }
  return writes;
}
