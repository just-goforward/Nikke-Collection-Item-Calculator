import type { RulesPort } from "../ingest/rules-port";
import { judgeCollaboration } from "./collaboration";
import {
  type DecisionInput,
  decisionIdentity,
  hash,
  maintainDecisions,
  notification,
  refreshRevisionDecision,
  requestDecision,
} from "./decisions";
import { gameDay } from "./game-day";
import { previousGrantOccurrences, unlinkPreviousGrant } from "./grant-correction";
import { judgeGrant } from "./grant-judgment";
import type { ExistingWindow } from "./identity";
import { maintenanceDependents } from "./maintenance-dependents";
import { postDependencies } from "./post-dependencies";
import { collaborationOptions, maintenanceConflictOptions } from "./schedule-options";
import type { Notice } from "./schedules";
import { interruptionEvidence, judgeMaintenance, judgeSolo } from "./schedules";
import { soloIdentity, soloRound } from "./solo-identity";

export type RulesConfiguration = { environment: "staging" | "production" };
let configuration: RulesConfiguration | undefined;
/** Explicit binding configuration; never infer an environment from source content. */
export function configureRules(value: RulesConfiguration): void {
  configuration = value;
}
type Window = ExistingWindow & { kind: string; revision: number; provenance: string | null };
type Decision = (
  type: DecisionInput["type"],
  options: DecisionInput["options"],
  eventId?: string | null,
  extracted?: DecisionInput["extracted"],
) => Promise<string>;
type PostWork = {
  db: D1Database;
  input: Parameters<RulesPort["processPostVersion"]>[1];
  now: string;
  key: string;
  post: Notice;
  url: string;
  windows: { results: Window[] };
  maintenance: Window[];
  writes: D1PreparedStatement[];
  result: { calendarDirty: boolean; decisionRequests: number; grants: number };
  reportedKits: { gameDay: string; ii: number; box: number }[];
  decision: Decision;
};

export const processPostVersion: RulesPort["processPostVersion"] = async (db, input, clock) => {
  if (!configuration) throw new Error("rules_environment_not_configured");
  const now = new Date(clock).toISOString();
  await maintainDecisions(db, now);
  const key = `post_${await hash(`${input.monitorId}:${input.feedId}:${input.versionId}`)}`;
  const empty = { calendarDirty: false, decisionRequests: 0, grants: 0 };
  if (
    await db
      .prepare("SELECT 1 FROM forecast_v2_admin_commands WHERE idempotency_key=?")
      .bind(key)
      .first()
  )
    return empty;
  const row = await db
    .prepare(`SELECT v.*,(
    SELECT h.metadata_json FROM forecast_v2_search_hits h WHERE h.feed_id=v.feed_id
    AND h.updated_date=v.updated_date ORDER BY h.run_id LIMIT 1) metadata_json
    FROM forecast_v2_post_versions v WHERE version_id=? AND feed_id=?`)
    .bind(input.versionId, input.feedId)
    .first<{
      body_text: string;
      created_at: string;
      content_hash: string;
      metadata_json: string | null;
    }>();
  if (!row?.metadata_json) throw new Error("post_version_metadata_missing");
  const currentVersion = await db
    .prepare(`SELECT version_id FROM forecast_v2_post_versions
    WHERE feed_id=? ORDER BY julianday(updated_date) DESC,julianday(fetched_at) DESC,version_id DESC LIMIT 1`)
    .bind(input.feedId)
    .first<{ version_id: string }>();
  if (currentVersion?.version_id !== input.versionId) return empty;
  await db
    .prepare(`UPDATE forecast_v2_decision_requests SET status='stale'
    WHERE status='pending' AND (
      json_extract(payload_json,'$.sourceVersion')<>? OR
      (json_extract(payload_json,'$.sourceVersion') IS NULL AND json_extract(payload_json,'$.sourceHash')<>?))
    AND EXISTS(SELECT 1 FROM json_each(payload_json,'$.feedIds') WHERE CAST(value AS TEXT)=?)`)
    .bind(input.versionId, row.content_hash, input.feedId)
    .run();
  const metadata = JSON.parse(row.metadata_json) as { title: string };
  const post = { title: metadata.title, body: row.body_text, postedAt: row.created_at };
  const url = `https://game.naver.com/lounge/nikke/board/detail/${input.feedId}`;
  const windows = await postDependencies(db, input.feedId, post);
  const maintenance = windows.results.filter((event) => event.kind === "maintenance");
  const writes: D1PreparedStatement[] = [];
  const result = { ...empty };
  const reportedKits: { gameDay: string; ii: number; box: number }[] = [];
  const decision = async (
    type: DecisionInput["type"],
    options: DecisionInput["options"],
    eventId: string | null = null,
    extracted?: DecisionInput["extracted"],
  ) => {
    const id = await decisionIdentity(input.feedId, input.versionId, type);
    await requestDecision(
      db,
      {
        id,
        type,
        environment: configuration!.environment,
        eventId,
        sourceHash: row.content_hash,
        sourceVersion: input.versionId,
        feedIds: [Number(input.feedId)],
        title: post.title,
        url,
        options,
        suppressNotification: input.monitorId === "B" && type === "solo_review",
        ...(extracted ? { extracted } : {}),
      },
      now,
    );
    result.decisionRequests++;
    return id;
  };
  const work: PostWork = {
    db,
    input,
    now,
    key,
    post,
    url,
    windows,
    maintenance,
    writes,
    result,
    reportedKits,
    decision,
  };
  if (["A", "B", "F"].includes(input.monitorId)) await processGrants(work);
  if (input.monitorId === "B") await reportInterruption(work);
  else if (["G", "C-open", "C-reopen", "E", "D"].includes(input.monitorId))
    await processSchedule(work);
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_admin_commands
    (command_id,idempotency_key,payload_hash,event_id,expected_revision,created_at)
    VALUES(?,?,?,NULL,0,?)`)
      .bind(key, key, row.content_hash, now),
  );
  await db.batch(writes);
  await refreshRevisionDecision(db, now);
  return result;
};

async function processGrants(work: PostWork) {
  const { db, input, now, post, maintenance, writes, result, reportedKits, decision } = work;
  const grant = judgeGrant(post, maintenance);
  if (grant.action !== "ignore") {
    const observation = `observation_${await hash(input.versionId)}`;
    writes.push(
      db
        .prepare(`INSERT INTO forecast_v2_grant_observations
        (observation_id,version_id,feed_id,ii_qty,box_qty,candidate_dates_json,date_basis,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(
          observation,
          input.versionId,
          input.feedId,
          grant.ii,
          grant.box,
          JSON.stringify(
            grant.action === "decision"
              ? grant.candidates
              : grant.instant
                ? [grant.instant]
                : [{ date: grant.gameDay, instant: null }],
          ),
          grant.action === "grant" ? grant.basis : "in_post_datetime",
          now,
        ),
    );
    if (grant.action === "decision") {
      await decision(
        "grant_date",
        grant.candidates.map((candidate, i) => ({
          id: `date_${i}`,
          label: candidate.instant ?? candidate.date,
        })),
      );
    } else {
      reportedKits.push({ gameDay: grant.gameDay, ii: grant.ii, box: grant.box });
      const previous = await previousGrantOccurrences(db, input.feedId);
      const conflict = await db
        .prepare(`SELECT occurrence_id FROM forecast_v2_grant_heads
          WHERE grant_game_day=? AND (ii_qty<>? OR box_qty<>?) LIMIT 1`)
        .bind(grant.gameDay, grant.ii, grant.box)
        .first();
      if (conflict || previous.length > 1)
        await decision("grant_quantity", [
          { id: "separate", label: "별도 지급" },
          { id: "correction", label: "정정" },
        ]);
      else {
        const occurrence = `grant_${grant.gameDay}_${grant.ii}_${grant.box}`;
        writes.push(
          db
            .prepare(`INSERT INTO forecast_v2_grant_revisions
            (occurrence_id,revision,grant_game_day,ii_qty,box_qty,created_at)
            VALUES(?,1,?,?,?,?) ON CONFLICT DO NOTHING`)
            .bind(occurrence, grant.gameDay, grant.ii, grant.box, now),
        );
        writes.push(
          db
            .prepare(`INSERT INTO forecast_v2_grant_heads VALUES(?,1,?,?,?)
            ON CONFLICT DO NOTHING`)
            .bind(occurrence, grant.gameDay, grant.ii, grant.box),
        );
        writes.push(
          db
            .prepare(`INSERT INTO forecast_v2_grant_links(link_id,occurrence_id,observation_id)
            VALUES(?,?,?) ON CONFLICT DO NOTHING`)
            .bind(`${observation}_${occurrence}`, occurrence, observation),
        );
        writes.push(...unlinkPreviousGrant(db, input.feedId, occurrence, previous));
        result.grants++;
        result.calendarDirty = true;
      }
    }
  }
}

async function reportInterruption(work: PostWork) {
  const { db, input, now, key, post, url, windows, maintenance, writes, reportedKits, decision } =
    work;
  const segments = interruptionEvidence(post, maintenance);
  const segment = segments.find((value) => value.startAt);
  const target = segment?.startAt
    ? windows.results.find(
        (event) =>
          event.kind === "solo" &&
          Date.parse(event.startAt) <= Date.parse(segment.startAt!) &&
          Date.parse(event.endAt) >= Date.parse(segment.startAt!),
      )
    : undefined;
  const startAt = segment?.kind === "suspend" ? target?.startAt : segment?.startAt;
  const endAt = segment?.kind === "suspend" ? segment.startAt : segment?.endAt;
  const id = await decision("solo_review", [], target?.id ?? null, {
    segments,
    ...(startAt ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
    kits: reportedKits,
  });
  writes.push(
    await notification(
      db,
      `${key}_report`,
      "b_report",
      {
        feedId: Number(input.feedId),
        title: post.title,
        url,
        postedAt: post.postedAt,
        extracted: { segments, kits: reportedKits },
        decisionRequestId: id,
      },
      now,
      { decisionId: id },
    ),
  );
}

async function processSchedule(work: PostWork) {
  const { input, post, windows, maintenance, decision } = work;
  const kind =
    input.monitorId === "G" ? "maintenance" : input.monitorId === "D" ? "collaboration" : "solo";
  let judged =
    kind === "maintenance"
      ? judgeMaintenance(post)
      : kind === "solo"
        ? judgeSolo(post, maintenance)
        : judgeCollaboration(
            post,
            maintenance,
            windows.results.filter((event) => event.kind === "collaboration"),
          );
  const identity =
    kind === "solo" && judged.action === "confirmed"
      ? soloIdentity(
          soloRound(post.title, post.body, input.feedId),
          input.feedId,
          judged.startAt,
          windows.results.filter((event) => event.kind === "solo"),
        )
      : null;
  const eventId = identity?.eventId ?? `${kind}_${input.feedId}`;
  if (kind === "maintenance" && judged.action === "confirmed") {
    const source = judged;
    const calendarDate = (instant: string) =>
      new Date(Date.parse(instant) + 9 * 3_600_000).toISOString().slice(0, 10);
    const conflicts = maintenance.filter(
      (event) =>
        event.id !== eventId && calendarDate(event.startAt) === calendarDate(source.startAt),
    );
    if (conflicts.length) {
      await decision(
        "maintenance",
        [
          ...maintenanceConflictOptions(source, conflicts),
          { id: "ignore", label: "기존 점검 유지" },
        ],
        conflicts.length === 1 ? conflicts[0]!.id : null,
        { startAt: source.startAt, endAt: source.endAt },
      );
      judged = { action: "ignore" };
    }
  }
  if (judged.action === "decision") {
    await requestScheduleDecision(work, kind, eventId);
  }
  if (judged.action === "confirmed" || judged.action === "create") {
    await storeSchedule(work, kind, judged, eventId, identity);
  }
}

async function requestScheduleDecision(
  work: PostWork,
  kind: "solo" | "maintenance" | "collaboration",
  eventId: string,
) {
  const { post, maintenance, decision } = work;
  const source = kind === "collaboration" ? judgeCollaboration(post, maintenance, []) : null;
  const extracted =
    source?.action === "create" ? { startAt: source.startAt, endAt: source.endAt } : undefined;
  await decision(
    kind === "solo" ? "solo_review" : kind,
    kind === "solo"
      ? []
      : extracted
        ? [
            { id: "new", label: "새 콜라보" },
            { id: "same", label: "기존 콜라보" },
            { id: "ignore", label: "관련 없음" },
          ]
        : [
            ...(kind === "collaboration" ? collaborationOptions(post, maintenance) : []),
            { id: "ignore", label: "관련 없음" },
          ],
    eventId,
    extracted,
  );
}

async function storeSchedule(
  work: PostWork,
  kind: "maintenance" | "collaboration" | "solo",
  judged: { startAt: string; endAt: string; maintenanceEventId?: string },
  eventId: string,
  identity: ReturnType<typeof soloIdentity> | null,
) {
  const { db, input, now, windows, maintenance, writes, result } = work;
  const previous = windows.results.find((event) => event.id === eventId);
  const revision = (previous?.revision ?? 0) + 1;
  const start = new Date(judged.startAt).toISOString(),
    end = new Date(judged.endAt).toISOString();
  const dependencyId = judged.maintenanceEventId ?? null;
  const dependencyRevision = dependencyId
    ? maintenance.find((event) => event.id === dependencyId)?.revision
    : null;
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
        (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,source_feed_ids_json,created_at,prediction_provenance_json,maintenance_event_id,maintenance_revision)
        VALUES(?,?,?,'confirmed',?,?,?,?,?,?,?,?,?)`)
      .bind(
        eventId,
        revision,
        kind,
        start,
        end,
        gameDay(start),
        gameDay(end),
        JSON.stringify([Number(input.feedId)]),
        now,
        JSON.stringify(identity ? { round: identity.round, segment: identity.segment } : {}),
        dependencyId,
        dependencyRevision ?? null,
      ),
  );
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_heads VALUES(?,?)
        ON CONFLICT(event_id) DO UPDATE SET revision=excluded.revision`)
      .bind(eventId, revision),
  );
  if (kind === "maintenance" && previous && previous.endAt !== end)
    writes.push(
      ...(await maintenanceDependents(
        db,
        eventId,
        revision,
        previous.endAt,
        end,
        now,
        configuration!.environment,
      )),
    );
  result.calendarDirty = true;
}
