import { CERTIFIED_SUPPLY_HISTORY_DAYS } from "../../../../shared/certifiedSupplyModel";
import { gameDayStartMs } from "../../../../shared/gameDay";
import type { SupplyForecastGrant } from "../../../../shared/supplyForecastCandidate";
import { SUPPLY_PROFILE_HORIZON_DAYS } from "../../../../shared/supplyForecastProjection";
import { buildConstructedForecastCandidate } from "../../constructed-candidate";
import { sha256Hex } from "../../crypto";
import { nextForecastRevision } from "../../db";
import { collapseSoloSegments } from "../../solo-interruptions";
import { processSourceQueue } from "../../source-queue";
import type { CollectorEnv, ScheduleEvent } from "../../types";
import { candidateOutcome } from "./alerts";
import { cachedInput, cacheStatements, inputSignature } from "./cache";
import { cadenceAnchor, readCadenceHistory } from "./history";
export type CandidateOutcome = Parameters<typeof candidateOutcome>[2];

type Head = {
  event_id: string;
  kind: "solo" | "collaboration";
  starts_at: string | null;
  ends_at: string | null;
  prediction_provenance_json: string | null;
  source_feed_ids_json: string;
  maintenance_event_id: string | null;
  maintenance_revision: number | null;
  revision: number;
  dependency_valid: number;
};
type Grant = { occurrence_id: string; grant_game_day: string; ii_qty: number; box_qty: number };

function grantInput(grant: Grant): SupplyForecastGrant {
  return {
    id: `grant:v2:${grant.occurrence_id}:${grant.grant_game_day}:1`,
    grantGameDate: grant.grant_game_day,
    refs: [
      ...(grant.ii_qty ? [{ lawId: "box-ii-v1", count: grant.ii_qty }] : []),
      ...(grant.box_qty ? [{ lawId: "regular-box-v1", count: grant.box_qty }] : []),
    ],
    claimWindowAssumed: true,
    sourceIds: [grant.occurrence_id],
    restatementOf: [],
  };
}

function segmentInput(head: Head, metadata: { round?: number; segment?: number }) {
  if (!metadata.round || !head.starts_at || !head.ends_at) return undefined;
  return {
    round: metadata.round,
    segment: metadata.segment ?? 1,
    kind: (metadata.segment ?? 1) > 1 ? ("reopen" as const) : ("initial" as const),
    effectiveFrom: head.starts_at,
    effectiveUntil: head.ends_at,
  };
}

async function readCandidateHeads(
  db: D1Database,
  now: number,
  anchorRound: number,
): Promise<Head[]> {
  return (
    await db
      .prepare(`SELECT r.*,
    (r.maintenance_event_id IS NULL OR EXISTS(
      SELECT 1 FROM forecast_v2_calendar_heads mh
      JOIN forecast_v2_calendar_revisions mr USING(event_id,revision)
      WHERE mh.event_id=r.maintenance_event_id AND mh.revision=r.maintenance_revision
        AND mr.kind='maintenance' AND mr.status='confirmed'
    )) AS dependency_valid FROM forecast_v2_calendar_heads h
    JOIN forecast_v2_calendar_revisions r USING(event_id,revision)
    WHERE r.status='confirmed' AND r.kind IN ('solo','collaboration')
      AND (r.starts_at IS NULL OR julianday(r.starts_at)<julianday(?))
      AND ((r.kind='solo' AND json_extract(r.prediction_provenance_json,'$.round')=?)
        OR r.ends_at IS NULL OR julianday(r.ends_at)>=julianday(?))
    ORDER BY r.starts_at,r.event_id LIMIT 41`)
      .bind(
        new Date(gameDayStartMs(now) + (SUPPLY_PROFILE_HORIZON_DAYS + 1) * 86400000).toISOString(),
        anchorRound,
        new Date(gameDayStartMs(now) - CERTIFIED_SUPPLY_HISTORY_DAYS * 86400000).toISOString(),
      )
      .all<Head>()
  ).results;
}

export async function runV2CandidateUnit(
  env: CollectorEnv,
  now: number,
): Promise<CandidateOutcome> {
  return candidateOutcome(env, now, await buildUnit(env, now));
}

async function readCandidateGrants(db: D1Database, now: number, until: string) {
  const rows = (
    await db
      .prepare(`SELECT * FROM forecast_v2_grant_heads
      WHERE grant_game_day>=? AND grant_game_day<? ORDER BY occurrence_id`)
      .bind(
        new Date(gameDayStartMs(now) - CERTIFIED_SUPPLY_HISTORY_DAYS * 86400000 + 9 * 3600000)
          .toISOString()
          .slice(0, 10),
        new Date(Date.parse(until) + 9 * 3600000).toISOString().slice(0, 10),
      )
      .all<Grant>()
  ).results;
  return rows.map(grantInput);
}

async function buildUnit(env: CollectorEnv, now: number): Promise<CandidateOutcome> {
  const held = (reason: string): CandidateOutcome => ({ outcome: "held", reason });
  if (env.FORECAST_V2_MODE !== "on") return held("v2_disabled");
  const db = env.FORECAST_DB;
  const until = new Date(
    gameDayStartMs(now) + (SUPPLY_PROFILE_HORIZON_DAYS + 1) * 86400000,
  ).toISOString();
  const history = await readCadenceHistory(db, until);
  const heads = await readCandidateHeads(db, now, cadenceAnchor(history));
  // Admission accepts forty results. The extra row detects overflow without
  // loading post bodies or constructing a candidate that cannot be admitted.
  if (heads.length > 40) return held("candidate_admission_capacity");
  const events: ScheduleEvent[] = [];
  for (const head of heads) {
    if (!head.starts_at || !head.ends_at) return held("calendar_period_missing");
    if (!head.dependency_valid) return held("maintenance_dependency_stale");
    const feed = (JSON.parse(head.source_feed_ids_json) as (string | number)[])[0];
    const post = await db
      .prepare(`SELECT * FROM forecast_v2_post_versions
      WHERE feed_id=? ORDER BY updated_date DESC,fetched_at DESC LIMIT 1`)
      .bind(String(feed))
      .first<{ feed_id: string; board_id: 11 | 48 | 56; body_text: string; created_at: string }>();
    if (!post) return held("calendar_evidence_missing");
    const metadata = JSON.parse(head.prediction_provenance_json ?? "{}") as {
      round?: number;
      segment?: number;
    };
    if (head.kind === "solo" && !metadata.round) return held("solo_round_missing");
    const item = {
      source: `naver-board-${post.board_id}` as const,
      itemId: post.feed_id,
      url: `https://game.naver.com/lounge/nikke/board/${post.board_id}/detail/${post.feed_id}`,
      title: head.event_id,
      excerpt: post.body_text.slice(0, 600),
      normalizedText: post.body_text,
      publishedAt: post.created_at,
      contentHash: await sha256Hex(post.body_text),
      structured: true,
      official: true,
    };
    const segment = segmentInput(head, metadata);
    events.push({
      eventId: `v2:${head.event_id}`,
      eventType: head.kind,
      sourceItem: item,
      startsAt: head.starts_at,
      endsAt: head.ends_at,
      scheduleStatus: "confirmed",
      manualReview: false,
      reason: null,
      ...(segment ? { segment, segments: [segment] } : {}),
    });
  }
  const soloEvidence = events.filter((event) => event.eventType === "solo");
  const solo = collapseSoloSegments(soloEvidence);
  const anchor = solo.at(-1);
  if (!anchor) return held("solo_anchor_missing");
  const grants = await readCandidateGrants(db, now, until);
  const gameDay = new Date(gameDayStartMs(now) + 9 * 3600000).toISOString().slice(0, 10);
  const signature = await inputSignature(env, gameDay, events, grants, history);
  if (await cachedInput(db, signature)) return { outcome: "unchanged" };
  const revision = await nextForecastRevision(db, gameDay);
  const candidate = await buildConstructedForecastCandidate(
    anchor.eventId,
    {
      event: anchor,
      soloEvents: solo,
      evidenceEvents: soloEvidence,
      scheduleStatus: "confirmed",
      cadenceDays: null,
    },
    events,
    { status: "x_unavailable", sourceItem: null, reason: null },
    now,
    revision,
    grants,
    { cadenceVersion: "observed-median-v2", confirmedRounds: history },
  );
  if (
    await db
      .prepare("SELECT 1 FROM forecast_candidates WHERE candidate_id=?")
      .bind(candidate.envelope.candidate.candidateId)
      .first()
  )
    return { outcome: "unchanged" };
  await processSourceQueue(
    db,
    {
      mode: "bootstrap",
      results: events.map((event) => ({
        source: event.sourceItem.source,
        itemId: event.sourceItem.itemId,
        outcome: "processed",
        item: event.sourceItem,
        event,
      })),
      candidate,
    },
    {
      after: cacheStatements(
        db,
        signature,
        candidate.envelope.candidate.candidateId,
        candidate.envelope.payloadHash,
        now,
      ),
    },
  );
  return { outcome: "built" };
}
