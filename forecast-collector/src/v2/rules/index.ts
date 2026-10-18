import { buildSnapshot } from "../../../../shared/certifiedSupplyBuild";
import {
  predictMedianSoloRaid,
  SOLO_RAID_ROUND_HISTORY,
  type SoloRaidRound,
} from "../../../../shared/soloRaidCadence";
import type { RulesPort } from "../ingest/rules-port";
import { dueEFollowUps as countFollowUps, maintainDecisions } from "./decisions";
import { addGameDays, calendarRange, gameDay, gameDayEnd, gameDayStart } from "./game-day";
import { applyPendingDecisions as applyDecisionStep } from "./pending-decisions";
import {
  processPostVersion as processStoredVersion,
  configureRules as setRulesConfiguration,
} from "./process";
import {
  type CalendarEvent,
  type CalendarGrant,
  type ProjectedDay,
  projectCalendar,
  semanticDiff,
} from "./projection";
import { refreshMaintenanceReviews } from "./refresh-reviews";
import { persistCalendar } from "./snapshot-store";

export function configureRules(configuration: Parameters<typeof setRulesConfiguration>[0]) {
  return setRulesConfiguration(configuration);
}
export function applyPendingDecisions(db: D1Database, now: number) {
  return applyDecisionStep(db, now);
}
export const processPostVersion: RulesPort["processPostVersion"] = (db, input, now) =>
  processStoredVersion(db, input, now);
const dueEFollowUps: RulesPort["dueEFollowUps"] = (db, now) =>
  countFollowUps(db, new Date(now).toISOString());

export const rebuildCalendar: RulesPort["rebuildCalendar"] = async (db, clock) => {
  const now = new Date(clock).toISOString();
  await maintainDecisions(db, now);
  await refreshMaintenanceReviews(db, now);
  const range = calendarRange(now);
  const dependencyStart = gameDayStart(addGameDays(range.start, -60));
  // Median cadence requires every confirmed round after the bundled history,
  // not every historical maintenance/collaboration event.
  const predictionStart = gameDayStart(SOLO_RAID_ROUND_HISTORY.at(-1)!.startGameDate);
  const rows = await db
    .prepare(`SELECT h.event_id id,h.revision,r.kind,r.status,
    h.event_id label,r.starts_at startAt,r.ends_at endAt,r.prediction_provenance_json provenance,
    r.source_feed_ids_json feedIds FROM forecast_v2_calendar_heads h
    JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision
    WHERE r.starts_at IS NOT NULL AND r.ends_at IS NOT NULL
    AND julianday(r.starts_at)<=julianday(?)
    AND (julianday(r.ends_at)>=julianday(?) OR
      (r.kind='solo' AND r.status='confirmed' AND julianday(r.starts_at)>=julianday(?)))`)
    .bind(gameDayEnd(range.end), dependencyStart, predictionStart)
    .all<CalendarEvent & { provenance: string | null; feedIds: string }>();
  const grants = (
    await db
      .prepare(`SELECT occurrence_id id,grant_game_day gameDay,
    ii_qty ii,box_qty box FROM forecast_v2_grant_heads WHERE grant_game_day BETWEEN ? AND ?`)
      .bind(range.start, range.end)
      .all<CalendarGrant>()
  ).results;
  const events = rows.results;
  const coop = cooperativeSupply(events, now);
  await appendPredictions(db, events, now);
  const days = projectCalendar(now, events, grants, coop);
  const pending = await db
    .prepare(`SELECT type,payload_json,expires_at FROM forecast_v2_decision_requests
    WHERE status='pending' AND julianday(expires_at)>julianday(?) ORDER BY decision_id`)
    .bind(now)
    .all<{ type: string; payload_json: string; expires_at: string }>();
  const coverage = await db
    .prepare(`SELECT s.stream_id,s.committed_created_at,s.consecutive_holds,
    (SELECT r.error_code FROM forecast_v2_monitor_runs r WHERE r.stream_id=s.stream_id
      AND r.status='held' ORDER BY r.generation DESC LIMIT 1) reason
    FROM forecast_v2_monitor_state s ORDER BY s.stream_id`)
    .all<{
      stream_id: string;
      committed_created_at: string | null;
      consecutive_holds: number;
      reason: string | null;
    }>();
  // The admin contract accepts bounded strings; separate fields preserve complete
  // URLs and expiries without truncating a combined display label.
  if (days[0])
    days[0].pending = [
      ...pending.results.flatMap((request) => {
        const payload = JSON.parse(request.payload_json) as { title: string; url: string };
        return [
          `결정 대기: ${request.type}`,
          payload.title,
          payload.url,
          `expiresAt: ${request.expires_at}`,
        ];
      }),
    ].flatMap((note) => note.match(/[\s\S]{1,200}/g) ?? []);
  if (days[0])
    days[0].coverage = coverage.results
      .flatMap((stream) => [
        `coverage ${stream.stream_id}: ${stream.committed_created_at ?? "never committed"}`,
        `coverage ${stream.stream_id} consecutive holds: ${stream.consecutive_holds}`,
        `coverage ${stream.stream_id} last hold: ${stream.reason ?? "none"}`,
      ])
      .flatMap((note) => note.match(/[\s\S]{1,200}/g) ?? []);
  const active = await db
    .prepare(`SELECT snapshot_id snapshotId,version FROM forecast_v2_calendar_active
    WHERE singleton=1`)
    .first<{ snapshotId: string; version: number }>();
  const previousDays = await previousProjection(db, active);
  const changes = projectionChanges(previousDays, days);
  return persistCalendar(db, days, changes, active, now);
};

function cooperativeSupply(events: readonly CalendarEvent[], now: string) {
  const supply = buildSnapshot({
    asOf: now,
    revision: "rules-calendar",
    sourceHash: "0".repeat(64),
    // This snapshot supplies only shared co-op events. Solo predictions below
    // require a validated anchor rather than a fabricated duration.
    soloPeriods: [],
    collaborationPeriods: events
      .filter((event) => event.kind === "collaboration" && event.status === "confirmed")
      .map((event) => ({ effectiveFrom: event.startAt, effectiveUntil: event.endAt })),
  });
  return supply.events
    .filter((event) => event.kind === "shop")
    .map((event) => ({
      gameDay: event.gameDate,
      ii: event.refs
        .filter((ref) => ref.lawId === "box-ii-v1")
        .reduce((sum, ref) => sum + ref.count, 0),
    }));
}

type StoredEvent = CalendarEvent & { provenance: string | null; feedIds: string };
async function appendPredictions(db: D1Database, events: StoredEvent[], now: string) {
  const history = new Map<number, SoloRaidRound>(
    SOLO_RAID_ROUND_HISTORY.map((entry) => [entry.round, entry]),
  );
  const confirmed = events
    .filter((event) => event.kind === "solo" && event.status === "confirmed")
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  for (const event of confirmed) {
    const round = event.provenance
      ? (JSON.parse(event.provenance) as { round?: number }).round
      : undefined;
    if (round && !history.has(round))
      history.set(round, {
        round,
        startGameDate: gameDay(event.startAt),
        status: "as_announced",
        sourceFeedId: JSON.parse(event.feedIds)[0],
      });
  }
  const ordered = [...history.values()].sort((a, b) => a.round - b.round);
  const anchor = confirmed.findLast(
    (event) => gameDay(event.startAt) === ordered.at(-1)?.startGameDate,
  );
  if (anchor) {
    const forecast = predictMedianSoloRaid({
      confirmedRounds: ordered,
      previousStart: anchor.startAt,
      previousEnd: anchor.endAt,
      asOf: now,
    });
    for (const [name, prediction] of [
      ["primary", forecast.primary],
      ["alternative", forecast.secondary],
    ] as const) {
      if (!prediction) continue;
      const id = `prediction_S${(ordered.at(-1)?.round ?? 0) + 1}_${name}`;
      const provenance = JSON.stringify({
        intervalDays: prediction.intervalDays,
        expectedNoticeAt: prediction.expectedNotice,
        ...(forecast.secondary
          ? {
              alternativeIntervalDays: forecast.secondary.intervalDays,
              alternativeStartsAt: forecast.secondary.start,
            }
          : {}),
      });
      const previous = await db
        .prepare(`SELECT revision,starts_at,ends_at,prediction_provenance_json
        FROM forecast_v2_calendar_revisions WHERE event_id=? ORDER BY revision DESC LIMIT 1`)
        .bind(id)
        .first<{
          revision: number;
          starts_at: string;
          ends_at: string;
          prediction_provenance_json: string;
        }>();
      const unchanged =
        previous?.starts_at === prediction.start &&
        previous.ends_at === prediction.end &&
        previous.prediction_provenance_json === provenance;
      const revision = unchanged ? previous.revision : (previous?.revision ?? 0) + 1;
      await db
        .prepare(`INSERT INTO forecast_v2_calendar_revisions
        (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,source_feed_ids_json,created_at,prediction_provenance_json)
        VALUES(?,?,'solo','predicted',?,?,?,?, '[]',?,?) ON CONFLICT DO NOTHING`)
        .bind(
          id,
          revision,
          prediction.start,
          prediction.end,
          gameDay(prediction.start),
          gameDay(prediction.end),
          now,
          provenance,
        )
        .run();
      events.push({
        id,
        revision,
        kind: "solo",
        status: "predicted",
        label: `${name}: ${prediction.status}`,
        startAt: prediction.start,
        endAt: prediction.end,
        provenance: JSON.stringify(forecast),
        feedIds: "[]",
      });
    }
  }
}

async function previousProjection(
  db: D1Database,
  active: { snapshotId: string; version: number } | null,
) {
  const previousLinks = active
    ? (
        await db
          .prepare(`SELECT l.game_day,r.event_id id,r.revision,r.kind,r.status,
    r.starts_at startAt,r.ends_at endAt FROM forecast_v2_calendar_event_links l
    JOIN forecast_v2_calendar_revisions r ON r.event_id=l.event_id AND r.revision=l.revision
    WHERE l.snapshot_id=?`)
          .bind(active.snapshotId)
          .all<CalendarEvent & { game_day: string }>()
      ).results
    : [];
  const previousDays: ProjectedDay[] | null = active
    ? (
        await db
          .prepare(
            "SELECT game_day,payload_json FROM forecast_v2_calendar_days WHERE snapshot_id=? ORDER BY game_day",
          )
          .bind(active.snapshotId)
          .all<{ game_day: string; payload_json: string }>()
      ).results.map((row) => {
        const payload = JSON.parse(row.payload_json) as {
          kits: { ii: number; box: number };
          coop: 0 | 5 | 10;
          grants: { label: string; ii: number; box: number }[];
          titles: Record<string, string>;
        };
        return {
          gameDay: row.game_day,
          ii: payload.kits.ii,
          box: payload.kits.box,
          coop: payload.coop,
          grants: payload.grants.map((grant) => ({
            id: grant.label,
            gameDay: row.game_day,
            ii: grant.ii,
            box: grant.box,
          })),
          events: previousLinks
            .filter((event) => event.game_day === row.game_day)
            .map((event) => ({ ...event, label: payload.titles[event.id] ?? event.id })),
        };
      })
    : null;
  return previousDays;
}

function projectionChanges(previousDays: ProjectedDay[] | null, days: ProjectedDay[]) {
  // Compare only dates common to the rolling view; entering/leaving days are quiet.
  const sharedDays = new Set(
    previousDays
      ?.map((day) => day.gameDay)
      .filter((day) => days.some((value) => value.gameDay === day)),
  );
  const state = (values: readonly ProjectedDay[]) => ({
    events: [
      ...new Map(
        values
          .filter((day) => sharedDays.has(day.gameDay))
          .flatMap((day) => day.events)
          .map((event) => [event.id, event]),
      ).values(),
    ],
    grants: values.filter((day) => sharedDays.has(day.gameDay)).flatMap((day) => day.grants),
  });
  return semanticDiff(previousDays ? state(previousDays) : null, state(days));
}

export const rulesPort: RulesPort = {
  processPostVersion,
  rebuildCalendar,
  dueEFollowUps,
  applyPendingDecisions,
};
