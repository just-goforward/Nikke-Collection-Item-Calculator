import { z } from "zod/mini";
import { board11InvocationGate } from "./board11-policy";
import { sha256Hex, stableJson } from "./crypto";
import {
  loadScheduleEvents,
  type StatementWriteCondition,
  sourceItemAndEventStatements,
} from "./db";
import { loadGrants, planGrants } from "./grants";
import { eventRound, segmentComparison } from "./solo-interruptions";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

const instant = z.string().check(z.iso.datetime({ offset: true }));
const positive = z.number().check(z.int(), z.minimum(1));
const bindingSchema = z.object({
  generation: z.number().check(z.int(), z.minimum(0)),
  sourceRevision: positive,
  contentHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  revisionHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  contextHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
});
export const typedResolutionSchema = z.union([
  z.object({
    kind: z.literal("suspend"),
    round: positive,
    cutoff: instant,
    binding: bindingSchema,
  }),
  z.object({
    kind: z.literal("reopen"),
    round: positive,
    from: instant,
    until: instant,
    binding: bindingSchema,
  }),
  z.object({
    kind: z.literal("grant"),
    grantGameDate: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
    kits: z
      .array(z.object({ law: z.enum(["box-ii-v1", "regular-box-v1"]), count: positive }))
      .check(z.minLength(1)),
    claimUntil: z.nullable(instant),
    binding: bindingSchema,
  }),
  z.object({
    kind: z.literal("restatement"),
    targetGrantId: z.string().check(z.minLength(1)),
    binding: bindingSchema,
  }),
]);
type Resolution = z.infer<typeof typedResolutionSchema>;

function resolutionEvent(
  input: Extract<Resolution, { kind: "suspend" | "reopen" }>,
  events: ScheduleEvent[],
  item: NormalizedSourceItem,
): ScheduleEvent {
  const round = events.filter((entry) => eventRound(entry) === input.round && !entry.manualReview);
  const base =
    input.kind === "suspend"
      ? round.find(
          (entry) =>
            entry.startsAt &&
            entry.endsAt &&
            Date.parse(entry.startsAt) < Date.parse(input.cutoff) &&
            Date.parse(entry.endsAt) >= Date.parse(input.cutoff),
        )
      : round.find((entry) => entry.segment?.kind === "suspend");
  if (!base?.startsAt) throw new Error("manual_review_round_evidence_missing");
  const from = input.kind === "suspend" ? base.startsAt : new Date(input.from).toISOString();
  const until = new Date(input.kind === "suspend" ? input.cutoff : input.until).toISOString();
  if (
    Date.parse(until) <= Date.parse(from) ||
    (input.kind === "reopen" && Date.parse(from) <= Date.parse(base.endsAt as string))
  )
    throw new Error("manual_review_schedule_range_invalid");
  return {
    eventId: `${item.source}:${item.itemId}:manual:${input.kind}`,
    eventType: "solo",
    sourceItem: item,
    startsAt: from,
    endsAt: until,
    scheduleStatus: "confirmed",
    manualReview: false,
    reason: null,
    segment: {
      round: input.round,
      segment:
        input.kind === "suspend" ? (base.segment?.segment ?? 1) : (base.segment?.segment ?? 1) + 1,
      kind: input.kind,
      effectiveFrom: from,
      effectiveUntil: until,
    },
  };
}

async function resolutionGrant(
  db: D1Database,
  item: NormalizedSourceItem,
  input: Extract<Resolution, { kind: "grant" }>,
  guard: StatementWriteCondition,
  schema27Allowed: ReturnType<typeof board11InvocationGate>,
) {
  const date = new Date(`${input.grantGameDate}T05:00:00+09:00`);
  if (
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10) !== input.grantGameDate
  )
    throw new Error("manual_review_grant_date_invalid");
  const plan = await planGrants(
    db,
    item,
    0,
    [
      {
        grantGameDate: input.grantGameDate,
        kits: input.kits,
        claimUntilKst:
          input.claimUntil === null
            ? null
            : `${new Date(Date.parse(input.claimUntil) + 9 * 3600000).toISOString().slice(0, 19)}+09:00`,
        claimWindowAssumed: input.claimUntil === null,
        explicitDate: true,
        restatement: false,
        evidence: item.excerpt,
      },
    ],
    guard,
    schema27Allowed,
  );
  if (plan.judgments.some((entry) => entry.comparison.blocking))
    throw new Error("manual_review_grant_conflict");
  return plan;
}

async function resolutionRestatement(
  db: D1Database,
  item: NormalizedSourceItem,
  input: Extract<Resolution, { kind: "restatement" }>,
  guard: StatementWriteCondition,
  now: string,
  statements: D1PreparedStatement[],
) {
  const target = (await loadGrants(db)).find((grant) => grant.id === input.targetGrantId);
  if (!target) throw new Error("manual_review_grant_not_found");
  const kits = new Map<string, number>();
  for (const ref of target.refs) kits.set(ref.lawId, (kits.get(ref.lawId) ?? 0) + ref.count);
  const grantEvidence = {
    grantGameDate: target.grantGameDate,
    kits: [...kits].map(([law, count]) => ({ law, count })),
    claimUntilKst: target.claimUntil ?? null,
    claimWindowAssumed: target.claimWindowAssumed,
  };
  statements.push(
    db
      .prepare(`INSERT INTO forecast_grant_restatements
      (source,item_id,content_hash,grant_id,evidence_json,created_at)
      SELECT ?,?,?,?,?,? WHERE (${guard.sql}) AND NOT EXISTS(SELECT 1 FROM forecast_grant_restatements
        WHERE source=? AND item_id=? AND content_hash=? AND grant_id=?)`)
      .bind(
        item.source,
        item.itemId,
        item.contentHash,
        input.targetGrantId,
        stableJson(input),
        now,
        ...guard.bindings,
        item.source,
        item.itemId,
        item.contentHash,
        input.targetGrantId,
      ),
  );
  return grantEvidence;
}

const scheduleSnapshot = `SELECT COALESCE(json_group_array(json_array(event_id,starts_at,ends_at,schedule_status,manual_review,reason,segment_json)),'[]') AS snapshot
  FROM (SELECT * FROM schedule_events ORDER BY event_id)`;
const grantSnapshot = `SELECT COALESCE(json_group_array(json_array(grant_id,content_hash,kits_json,claim_until,claim_window_assumed)),'[]') AS snapshot
  FROM (SELECT * FROM forecast_grant_revisions ORDER BY grant_id,content_hash)`;

export async function typedBinding(db: D1Database, reviewId: string) {
  const row = await db
    .prepare(`SELECT b.*,r.source,r.item_id FROM source_manual_review_bindings b
    JOIN source_manual_reviews r ON r.review_id=b.review_id WHERE b.review_id=?
    AND b.source_revision=(SELECT MAX(source_revision) FROM source_notice_revisions WHERE source=r.source AND item_id=r.item_id)`)
    .bind(reviewId)
    .first<{
      source_revision: number;
      body_hash: string;
      revision_hash: string;
      generation: number;
      metadata_json: string;
      item_json: string;
      source: string;
      item_id: string;
    }>();
  if (!row) return null;
  const schedule = await db.prepare(scheduleSnapshot).first<string>("snapshot");
  const grants = await db.prepare(grantSnapshot).first<string>("snapshot");
  const contextHash = await sha256Hex(
    stableJson({ metadata: row.metadata_json, schedule, grants }),
  );
  return {
    binding: {
      generation: row.generation,
      sourceRevision: row.source_revision,
      contentHash: row.body_hash,
      revisionHash: row.revision_hash,
      contextHash,
    },
    item: JSON.parse(row.item_json) as NormalizedSourceItem,
    admission: {
      sql: `(${scheduleSnapshot})=? AND (${grantSnapshot})=?`,
      bindings: [schedule, grants],
    } satisfies StatementWriteCondition,
    condition: {
      sql: `EXISTS(SELECT 1 FROM source_notice_revisions WHERE source=? AND item_id=? AND source_revision=?
        AND source_revision=(SELECT MAX(source_revision) FROM source_notice_revisions WHERE source=? AND item_id=?)
        AND body_hash=? AND revision_hash=?)`,
      bindings: [
        row.source,
        row.item_id,
        row.source_revision,
        row.source,
        row.item_id,
        row.body_hash,
        row.revision_hash,
      ],
    } satisfies StatementWriteCondition,
  };
}
export async function prepareTypedResolution(
  db: D1Database,
  reviewId: string,
  input: Resolution,
  condition: StatementWriteCondition,
  now: string,
  schema27Allowed = board11InvocationGate(db),
) {
  if (!(await schema27Allowed())) throw new Error("board11_schema_required");
  const current = await typedBinding(db, reviewId);
  if (!current || stableJson(current.binding) !== stableJson(input.binding))
    throw new Error("manual_review_stale_evidence");
  const guard = {
    sql: `(${condition.sql}) AND (${current.condition.sql}) AND EXISTS(
      SELECT 1 FROM source_manual_resolution_evidence WHERE review_id=? AND content_hash=?)`,
    bindings: [
      ...condition.bindings,
      ...current.condition.bindings,
      reviewId,
      current.item.contentHash,
    ],
  };
  const item = current.item;
  const events = await loadScheduleEvents(db);
  let event: ScheduleEvent | undefined;
  let grantEvidence: unknown;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO source_manual_resolution_evidence
    (review_id,content_hash,created_at) SELECT ?,?,? WHERE (${condition.sql}) AND (${current.condition.sql})
    AND (${current.admission.sql})`)
      .bind(
        reviewId,
        item.contentHash,
        now,
        ...condition.bindings,
        ...current.condition.bindings,
        ...current.admission.bindings,
      ),
  ];
  if (input.kind === "suspend" || input.kind === "reopen") {
    event = resolutionEvent(input, events, item);
  } else if (input.kind === "grant") {
    const plan = await resolutionGrant(db, item, input, guard, schema27Allowed);
    statements.push(...plan.statements);
    event = plan.judgments[0]?.event;
    grantEvidence = plan.judgments[0]?.comparison.grant;
  } else {
    grantEvidence = await resolutionRestatement(db, item, input, guard, now, statements);
  }
  if (event) statements.push(...sourceItemAndEventStatements(db, [item], [event], now, guard));
  const comparison = {
    known: {
      segments: events.flatMap((known) =>
        known.segment && event?.segment?.round === known.segment.round
          ? [segmentComparison(known.segment)]
          : [],
      ),
    },
    segments: event?.segment ? [segmentComparison(event.segment)] : [],
    ...(grantEvidence ? { grant: grantEvidence } : {}),
    blocking: false,
    resolution: input.kind,
  };
  statements.push(
    db
      .prepare(`INSERT INTO source_judgment_evidence
    (source,item_id,content_hash,rule_version,block_index,judged_at,verdict,reason,question,triggers_json,block_excerpt,comparison_json,context_hash)
    SELECT ?,?,?,'solo-section-v2',0,?,?,NULL,?,'[]',?,?,? WHERE (${guard.sql})`)
      .bind(
        item.source,
        item.itemId,
        item.contentHash,
        now,
        event?.eventType === "solo" ? "solo" : "schedule_change",
        "세대와 본문 및 근거에 결합된 수동 해결",
        item.excerpt,
        stableJson(comparison),
        await sha256Hex(stableJson(input)),
        ...guard.bindings,
      ),
  );
  statements.push(
    db
      .prepare(`UPDATE schedule_events SET manual_review=1,reason='runtime_notice_replaced'
    WHERE source=? AND source_item_id=? AND event_id<>? AND (${guard.sql})`)
      .bind(item.source, item.itemId, event?.eventId ?? "", ...guard.bindings),
  );
  return { statements, guard };
}
