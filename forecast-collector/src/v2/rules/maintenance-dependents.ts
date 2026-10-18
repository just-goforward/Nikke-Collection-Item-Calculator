import { decisionIdentity, requestDecision } from "./decisions";
import { collaborationEnd, gameDay } from "./game-day";

/** Statements are appended after the corrected G revision in the same atomic batch. */
export async function maintenanceDependents(
  db: D1Database,
  eventId: string,
  revision: number,
  oldEnd: string,
  end: string,
  now: string,
  environment?: "staging" | "production",
): Promise<D1PreparedStatement[]> {
  const dependents = await db
    .prepare(`SELECT r.* FROM forecast_v2_calendar_heads h
    JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision
    WHERE r.maintenance_event_id=? AND r.status='confirmed'`)
    .bind(eventId)
    .all<{
      event_id: string;
      revision: number;
      kind: string;
      ends_at: string;
      source_feed_ids_json: string;
      prediction_provenance_json: string | null;
    }>();
  const statements: D1PreparedStatement[] = [];
  for (const dependent of dependents.results) {
    const until = dependent.kind === "collaboration" ? collaborationEnd(end) : dependent.ends_at;
    if (Date.parse(until) <= Date.parse(end))
      throw new Error("maintenance_dependency_period_invalid");
    statements.push(
      db
        .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,
      maintenance_event_id,maintenance_revision,prediction_provenance_json,source_feed_ids_json,created_at)
      VALUES(?,?,?,'confirmed',?,?,?,?,?,?,?,?,?)`)
        .bind(
          dependent.event_id,
          dependent.revision + 1,
          dependent.kind,
          end,
          until,
          gameDay(end),
          gameDay(until),
          eventId,
          revision,
          dependent.prediction_provenance_json,
          dependent.source_feed_ids_json,
          now,
        ),
    );
    statements.push(
      db
        .prepare("UPDATE forecast_v2_calendar_heads SET revision=? WHERE event_id=? AND revision=?")
        .bind(dependent.revision + 1, dependent.event_id, dependent.revision),
    );
  }
  if (gameDay(oldEnd) === gameDay(end)) return statements;
  statements.push(...(await maintenanceGrants(db, eventId, revision, end, now, environment)));
  return statements;
}

type GrantHead = { occurrence_id: string; revision: number; ii_qty: number; box_qty: number };
type GrantDestination = { occurrence_id: string; ii_qty: number; box_qty: number };

async function maintenanceGrants(
  db: D1Database,
  eventId: string,
  revision: number,
  end: string,
  now: string,
  environment?: "staging" | "production",
) {
  const statements: D1PreparedStatement[] = [];
  const grants = await db
    .prepare(`SELECT DISTINCT h.* FROM forecast_v2_grant_heads h
    JOIN forecast_v2_grant_links l ON l.occurrence_id=h.occurrence_id
    JOIN forecast_v2_grant_observations o ON o.observation_id=l.observation_id
    WHERE o.date_basis='maintenance_end' AND EXISTS(
      SELECT 1 FROM json_each(o.candidate_dates_json) d JOIN forecast_v2_calendar_revisions m
      ON julianday(d.value)=julianday(m.ends_at) WHERE m.event_id=? AND m.kind='maintenance')`)
    .bind(eventId)
    .all<{ occurrence_id: string; revision: number; ii_qty: number; box_qty: number }>();
  for (const grant of grants.results) {
    const destinations = (
      await db
        .prepare(`SELECT occurrence_id,ii_qty,box_qty FROM forecast_v2_grant_heads
      WHERE grant_game_day=? AND occurrence_id<>?`)
        .bind(gameDay(end), grant.occurrence_id)
        .all<{ occurrence_id: string; ii_qty: number; box_qty: number }>()
    ).results;
    const exact = destinations.find(
      (target) => target.ii_qty === grant.ii_qty && target.box_qty === grant.box_qty,
    );
    if (destinations.length) {
      await collideGrant(db, grant, exact, eventId, revision, end, now, environment, statements);
      continue;
    }
    statements.push(
      db
        .prepare(`INSERT INTO forecast_v2_grant_revisions
      (occurrence_id,revision,grant_game_day,ii_qty,box_qty,created_at) VALUES(?,?,?,?,?,?)`)
        .bind(
          grant.occurrence_id,
          grant.revision + 1,
          gameDay(end),
          grant.ii_qty,
          grant.box_qty,
          now,
        ),
    );
    statements.push(
      db
        .prepare(`UPDATE forecast_v2_grant_heads SET revision=?,grant_game_day=?
      WHERE occurrence_id=? AND revision=?`)
        .bind(grant.revision + 1, gameDay(end), grant.occurrence_id, grant.revision),
    );
  }
  return statements;
}

async function collideGrant(
  db: D1Database,
  grant: GrantHead,
  exact: GrantDestination | undefined,
  eventId: string,
  revision: number,
  end: string,
  now: string,
  environment: "staging" | "production" | undefined,
  statements: D1PreparedStatement[],
) {
  const moving = (
    await db
      .prepare(`SELECT l.link_id,l.observation_id,o.feed_id,v.content_hash
        FROM forecast_v2_grant_links l JOIN forecast_v2_grant_observations o ON o.observation_id=l.observation_id
        JOIN forecast_v2_post_versions v ON v.version_id=o.version_id
        WHERE l.occurrence_id=? AND o.date_basis='maintenance_end' AND EXISTS(
          SELECT 1 FROM json_each(o.candidate_dates_json) d JOIN forecast_v2_calendar_revisions m
          ON julianday(d.value)=julianday(m.ends_at) WHERE m.event_id=?)`)
      .bind(grant.occurrence_id, eventId)
      .all<{
        link_id: string;
        observation_id: string;
        feed_id: string;
        content_hash: string;
      }>()
  ).results;
  for (const link of moving) {
    if (exact) {
      statements.push(
        db
          .prepare(`INSERT INTO forecast_v2_grant_links(link_id,occurrence_id,observation_id)
            VALUES(?,?,?) ON CONFLICT DO NOTHING`)
          .bind(
            `${exact.occurrence_id}_${link.observation_id}`,
            exact.occurrence_id,
            link.observation_id,
          ),
      );
    } else {
      if (!environment) throw new Error("maintenance_collision_environment_required");
      await requestDecision(
        db,
        {
          id: await decisionIdentity("maintenance_grant", eventId, revision, link.observation_id),
          type: "grant_quantity",
          environment,
          eventId: null,
          sourceHash: link.content_hash,
          feedIds: [Number(link.feed_id)],
          title: "점검 종료 변경에 따른 지급 수량 확인",
          url: `https://game.naver.com/lounge/nikke/board/detail/${link.feed_id}`,
          options: [
            { id: "separate", label: "별도 지급" },
            { id: "correction", label: "정정" },
          ],
          extracted: { startAt: end },
        },
        now,
      );
    }
    statements.push(
      db.prepare("DELETE FROM forecast_v2_grant_links WHERE link_id=?").bind(link.link_id),
    );
  }
  statements.push(
    db
      .prepare(`DELETE FROM forecast_v2_grant_heads WHERE occurrence_id=?
        AND NOT EXISTS(SELECT 1 FROM forecast_v2_grant_links WHERE occurrence_id=?)`)
      .bind(grant.occurrence_id, grant.occurrence_id),
  );
}
