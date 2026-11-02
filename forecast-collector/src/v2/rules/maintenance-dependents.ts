import { kstLabel } from "../../../../shared/forecastV2Notifications";
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
  // Every grant in the batch is classified first: the ambiguity lookahead needs the link
  // set the *whole* batch leaves behind, not just one grant's own moving links.
  const planned: {
    grant: GrantHead;
    destinations: GrantDestination[];
    exact: GrantDestination | undefined;
  }[] = [];
  for (const grant of grants.results) {
    const destinations = (
      await db
        .prepare(`SELECT occurrence_id,ii_qty,box_qty FROM forecast_v2_grant_heads
      WHERE grant_game_day=? AND occurrence_id<>?`)
        .bind(gameDay(end), grant.occurrence_id)
        .all<GrantDestination>()
    ).results;
    planned.push({
      grant,
      destinations,
      exact: destinations.find(
        (target) => target.ii_qty === grant.ii_qty && target.box_qty === grant.box_qty,
      ),
    });
  }
  const batch = await batchLinkOutcome(db, eventId, planned);
  for (const { grant, destinations, exact } of planned) {
    if (destinations.length) {
      await collideGrant(
        db,
        grant,
        exact,
        eventId,
        revision,
        end,
        now,
        environment,
        statements,
        batch,
      );
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

/** The link state this batch produces, per feed, as `persistGrantDecision` will see it. */
type BatchLinks = {
  /** Every link id the batch deletes, across all colliding grants. */
  removed: ReadonlySet<string>;
  /** Occurrences that receive a new link of the feed through an `exact` re-link. */
  relinked: ReadonlyMap<string, readonly string[]>;
  /** The moving links of one colliding grant, so it can emit its own statements. */
  movingOf: (occurrenceId: string) => readonly MovingLink[];
};
type MovingLink = {
  link_id: string;
  observation_id: string;
  feed_id: string;
  content_hash: string;
};

async function batchLinkOutcome(
  db: D1Database,
  eventId: string,
  planned: readonly {
    grant: GrantHead;
    destinations: GrantDestination[];
    exact: GrantDestination | undefined;
  }[],
): Promise<BatchLinks> {
  const removed = new Set<string>();
  const relinked = new Map<string, Set<string>>();
  const byGrant = new Map<string, readonly MovingLink[]>();
  for (const { grant, destinations, exact } of planned) {
    if (!destinations.length) continue;
    const moving = await movingLinks(db, grant.occurrence_id, eventId);
    byGrant.set(grant.occurrence_id, moving);
    for (const link of moving) {
      removed.add(link.link_id);
      if (!exact) continue;
      const kept = relinked.get(link.feed_id) ?? new Set<string>();
      kept.add(exact.occurrence_id);
      relinked.set(link.feed_id, kept);
    }
  }
  return {
    removed,
    relinked: new Map([...relinked].map(([feed, ids]) => [feed, [...ids]])),
    movingOf: (occurrenceId) => byGrant.get(occurrenceId) ?? [],
  };
}

async function movingLinks(db: D1Database, occurrenceId: string, eventId: string) {
  return (
    await db
      .prepare(`SELECT l.link_id,l.observation_id,o.feed_id,v.content_hash
        FROM forecast_v2_grant_links l JOIN forecast_v2_grant_observations o ON o.observation_id=l.observation_id
        JOIN forecast_v2_post_versions v ON v.version_id=o.version_id
        WHERE l.occurrence_id=? AND o.date_basis='maintenance_end' AND EXISTS(
          SELECT 1 FROM json_each(o.candidate_dates_json) d JOIN forecast_v2_calendar_revisions m
          ON julianday(d.value)=julianday(m.ends_at) WHERE m.event_id=?)`)
      .bind(occurrenceId, eventId)
      .all<MovingLink>()
  ).results;
}

/**
 * Occurrences this feed still has once this batch applies — the same set
 * `previousGrantOccurrences` sees inside `persistGrantDecision`. Every link the batch
 * deletes is excluded, across every colliding grant, and a re-link into an existing
 * occurrence (the `exact` destination) counts that occurrence again.
 *
 * Both id lists travel as one JSON array each: a batch can move more links than D1's
 * 100 bound-parameter limit, so the bind count here stays constant.
 */
async function remainingOccurrences(
  db: D1Database,
  feedId: string,
  removedLinkIds: readonly string[],
  relinkedOccurrences: readonly string[],
) {
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT occurrence_id) AS n FROM (
    SELECT l.occurrence_id AS occurrence_id FROM forecast_v2_grant_links l
    JOIN forecast_v2_grant_observations o USING(observation_id)
    JOIN forecast_v2_grant_heads h USING(occurrence_id)
    WHERE o.feed_id=? AND l.link_id NOT IN (SELECT value FROM json_each(?))
    UNION SELECT value AS occurrence_id FROM json_each(?))`)
    .bind(feedId, JSON.stringify(removedLinkIds), JSON.stringify(relinkedOccurrences))
    .first<{ n: number }>();
  return row?.n ?? 0;
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
  batch: BatchLinks,
) {
  const moving = batch.movingOf(grant.occurrence_id);
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
      // persistGrantDecision rejects BOTH options when this feed keeps several prior
      // occurrences (grant_correction_target_ambiguous). It counts what survives the
      // whole batch, so count that same set here.
      const remaining = await remainingOccurrences(
        db,
        link.feed_id,
        [...batch.removed],
        batch.relinked.get(link.feed_id) ?? [],
      );
      const ambiguous = remaining > 1;
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
          evidence: {
            goal: "점검 종료 변경에 따른 지급 수량 확인",
            reason: ambiguous ? "grant_quantity_ambiguous" : "grant_quantity",
            confirmed: [
              `점검 종료가 ${kstLabel(end)}로 변경되었습니다.`,
              `이전 관측 수량: 관리 키트 II ${grant.ii_qty} · 상자 ${grant.box_qty}`,
              ...(ambiguous ? [`이 공지의 이전 지급 기록: ${remaining}건`] : []),
            ],
            guessed: [],
            noGuess: "수량 판단만 남아 있어 일정 추측은 없습니다.",
            ...(ambiguous
              ? {}
              : {
                  blocked:
                    "점검 종료일이 바뀌면서 같은 날 이미 다른 수량의 지급이 달력에 있어 별도 지급인지 정정인지 확인이 필요합니다.",
                  todo: "새로 더 지급된 것이면 [별도 지급], 기존 수량을 고치는 것이면 [정정]을 눌러 주세요.",
                }),
          },
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
