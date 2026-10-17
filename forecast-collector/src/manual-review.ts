import { z } from "zod/mini";
import { board11InvocationGate } from "./board11-policy";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { sha256Hex, stableJson } from "./crypto";
import {
  candidateStatements,
  loadScheduleEvents,
  nextForecastRevision,
  type StatementWriteCondition,
  sourceItemAndEventStatements,
} from "./db";
import { buildNoticeCandidate } from "./notice-processing";
import { loadRuntimeEvents } from "./runtime-events";
import { prepareTypedResolution, typedBinding, typedResolutionSchema } from "./typed-resolutions";
import type { NaverSourceKind, NormalizedSourceItem, ScheduleEvent } from "./types";

const REVIEW_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const reviewIdPattern = /^mr-[0-9a-f]{32}$/;
const requestIdPattern = /^mrq-[0-9a-f]{32}$/;
const kstMinutePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const eventInputSchema = z.object({
  eventType: z.enum(["solo", "cooperation", "collaboration", "schedule_change", "reward"]),
  startsAtKst: z.string().check(z.regex(kstMinutePattern)),
  endsAtKst: z.nullable(z.string().check(z.regex(kstMinutePattern))),
  scheduleStatus: z.enum(["confirmed", "estimated"]),
});

const decisionInputSchema = z.object({
  requestId: z.string().check(z.regex(requestIdPattern)),
  decision: z.enum(["requeue", "ignore", "manual_event"]),
  reason: z.string().check(z.minLength(1), z.maxLength(240)),
  runId: z.number().check(z.int(), z.minimum(1)),
  event: z.nullable(eventInputSchema),
  resolution: z.optional(typedResolutionSchema),
});

type ManualReviewDecisionInput = z.infer<typeof decisionInputSchema>;
type ManualReviewDecision = ManualReviewDecisionInput["decision"];

type ManualReviewRow = {
  review_id: string;
  source: NaverSourceKind;
  item_id: string;
  generation: number;
  state: "pending" | "resolved" | "expired";
  decision: ManualReviewDecision | null;
  actor: string | null;
  reason: string | null;
  request_id: string | null;
  request_payload_hash: string | null;
  event_payload_hash: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  url: string;
  title: string;
  published_at: string;
  error_code: string | null;
  queue_status: string;
  writeCondition?: StatementWriteCondition;
};

type SourceItemRow = {
  source: NaverSourceKind;
  item_id: string;
  url: string;
  title: string;
  excerpt: string;
  published_at: string;
  content_hash: string;
  structured: number;
  official: number;
};

type PreparedManualReviewDecision = {
  priorStatements: D1PreparedStatement[];
  queueStatement: D1PreparedStatement;
  candidateCreated: boolean;
  eventPayloadHash: string | null;
};

export async function ensureManualReviewStatement(
  db: D1Database,
  source: NaverSourceKind,
  itemId: string,
  nowIso: string,
) {
  const expiresAt = new Date(Date.parse(nowIso) + REVIEW_TTL_MS).toISOString();
  return db
    .prepare(
      `INSERT OR IGNORE INTO source_manual_reviews (
         review_id, source, item_id, generation, state, created_at, expires_at
       )
       SELECT 'mr-' || lower(hex(randomblob(16))), source, item_id, review_generation,
              'pending', ?, ?
       FROM source_queue
       WHERE source = ? AND item_id = ? AND status = 'manual_review'
       AND (source<>'naver-board-11' OR EXISTS(SELECT 1 FROM schema_migrations WHERE version>=27))`,
    )
    .bind(nowIso, expiresAt, source, itemId);
}

export async function listManualReviews(
  db: D1Database,
  options: { status: "pending" | "resolved" | "expired"; limit: number },
) {
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit)));
  const rows = await db
    .prepare(
      `${reviewSelectSql()} WHERE
       CASE WHEN r.state = 'pending' AND r.expires_at <= ? THEN 'expired' ELSE r.state END = ?
       ORDER BY r.created_at, r.review_id LIMIT ?`,
    )
    .bind(now, options.status, limit)
    .all<ManualReviewRow>();
  return rows.results.map((row) => publicManualReview(effectiveManualReview(row, now)));
}

export async function readManualReview(
  db: D1Database,
  reviewId: string,
  schema27Allowed = board11InvocationGate(db),
) {
  if (!reviewIdPattern.test(reviewId)) return null;
  const row = await db
    .prepare(`${reviewSelectSql()} WHERE r.review_id = ?`)
    .bind(reviewId)
    .first<ManualReviewRow>();
  if (!row) return null;
  const bound = (await schema27Allowed()) ? await typedBinding(db, reviewId) : null;
  return {
    ...publicManualReview(effectiveManualReview(row, new Date().toISOString())),
    ...(bound ? { resolutionBinding: bound.binding } : {}),
  };
}

function effectiveManualReview(row: ManualReviewRow, now: string): ManualReviewRow {
  return row.state === "pending" && row.expires_at <= now ? { ...row, state: "expired" } : row;
}

export async function renewManualReview(
  db: D1Database,
  environment: "staging" | "production",
  reviewId: string,
  raw: unknown,
) {
  const schema27Allowed = board11InvocationGate(db);
  const input = z
    .object({
      environment: z.enum(["staging", "production"]),
      expectedGeneration: z.number().check(z.int(), z.minimum(0)),
      requestId: z.string().check(z.regex(requestIdPattern)),
      reason: z.string().check(z.minLength(1), z.maxLength(240)),
    })
    .parse(raw);
  if (input.environment !== environment) throw new Error("manual_review_environment_conflict");
  if (!reviewIdPattern.test(reviewId)) throw new Error("manual_review_id_invalid");
  const hash = await sha256Hex(stableJson({ operation: "renew", reviewId, ...input }));
  const newId = `mr-${(await sha256Hex(`renew:${environment}:${input.requestId}`)).slice(0, 32)}`;
  const prior = await db
    .prepare("SELECT review_id,request_payload_hash FROM source_manual_reviews WHERE request_id=?")
    .bind(input.requestId)
    .first<{ review_id: string; request_payload_hash: string }>();
  if (prior) {
    if (prior.review_id !== reviewId || prior.request_payload_hash !== hash) {
      throw new Error("manual_review_request_conflict");
    }
    return { review: await readManualReview(db, newId, schema27Allowed), idempotent: true };
  }
  const review = await db
    .prepare(`${reviewSelectSql()} WHERE r.review_id=?`)
    .bind(reviewId)
    .first<ManualReviewRow>();
  if (!review) throw new Error("manual_review_not_found");
  if (review.source === "naver-board-11" && !(await schema27Allowed()))
    throw new Error("board11_schema_required");
  if (review.state === "resolved" || review.queue_status !== "manual_review") {
    throw new Error("manual_review_not_pending");
  }
  if (review.generation !== input.expectedGeneration) {
    throw new Error("manual_review_generation_conflict");
  }
  const now = new Date().toISOString();
  const key = manualReviewAlertKey(environment, review.source, review.item_id);
  const results = await db.batch([
    db
      .prepare(`UPDATE source_manual_reviews
      SET state='expired',resolved_at=?,request_id=?,request_payload_hash=?,reason=?
      WHERE review_id=? AND state IN ('pending','expired') AND request_id IS NULL
        AND generation=? AND EXISTS (
          SELECT 1 FROM source_queue q WHERE q.source=source_manual_reviews.source
          AND q.item_id=source_manual_reviews.item_id AND q.status='manual_review'
          AND q.review_generation=source_manual_reviews.generation)
        AND NOT EXISTS (SELECT 1 FROM forecast_ops_alerts WHERE alert_key=? AND environment<>?)`)
      .bind(
        now,
        input.requestId,
        hash,
        input.reason,
        reviewId,
        input.expectedGeneration,
        key,
        environment,
      ),
    db
      .prepare(`UPDATE source_queue SET review_generation=review_generation+1,updated_at=?
      WHERE source=? AND item_id=? AND status='manual_review' AND review_generation=? AND changes()=1`)
      .bind(now, review.source, review.item_id, input.expectedGeneration),
    db
      .prepare(`INSERT INTO source_manual_reviews
      (review_id,source,item_id,generation,state,created_at,expires_at)
      SELECT ?,?,?,?,'pending',?,? WHERE changes()=1`)
      .bind(
        newId,
        review.source,
        review.item_id,
        input.expectedGeneration + 1,
        now,
        new Date(Date.parse(now) + REVIEW_TTL_MS).toISOString(),
      ),
    db
      .prepare(`UPDATE forecast_ops_alerts SET state='resolved',resolved_at=?,
      discord_message_id=NULL,last_sent_at=NULL,last_sent_occurrence_count=0,
      next_send_at=NULL,recovery_sent_at=NULL,last_send_error=NULL
      WHERE alert_key=? AND environment=? AND changes()=1`)
      .bind(now, key, environment),
  ]);
  if (Number(results[2]?.meta.changes) !== 1) {
    const winner = await db
      .prepare(
        "SELECT request_id,request_payload_hash FROM source_manual_reviews WHERE review_id=?",
      )
      .bind(reviewId)
      .first<{ request_id: string | null; request_payload_hash: string | null }>();
    if (winner?.request_id === input.requestId && winner.request_payload_hash === hash) {
      return { review: await readManualReview(db, newId, schema27Allowed), idempotent: true };
    }
    throw new Error("manual_review_renewal_race");
  }
  return { review: await readManualReview(db, newId, schema27Allowed), idempotent: false };
}

export async function decideManualReview(
  db: D1Database,
  environment: "staging" | "production",
  reviewId: string,
  raw: unknown,
  options: { actor?: string; nowMs?: number; runtimeIngestion?: boolean } = {},
) {
  const schema27Allowed = board11InvocationGate(db);
  if (!reviewIdPattern.test(reviewId)) throw new Error("manual_review_id_invalid");
  const input = parseDecisionInput(raw);
  const payloadHash = await sha256Hex(stableJson(input));
  const idempotentResult = await readIdempotentDecision(db, reviewId, input.requestId, payloadHash);
  if (idempotentResult) return idempotentResult;

  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  await expireManualReviews(db, nowMs);
  const review = await db
    .prepare(`${reviewSelectSql()} WHERE r.review_id = ?`)
    .bind(reviewId)
    .first<ManualReviewRow>();
  if (!review) throw new Error("manual_review_not_found");
  if (review.state !== "pending" || review.queue_status !== "manual_review") {
    throw new Error("manual_review_not_pending");
  }

  const actor = boundedActor(options.actor ?? `github-actions:${input.runId}`);
  const prepared = await prepareManualReviewDecision(
    db,
    review,
    input,
    now,
    nowMs,
    environment === "staging" && options.runtimeIngestion === true,
    schema27Allowed,
  );
  const reviewStatement = db
    .prepare(
      `UPDATE source_manual_reviews
         SET state = 'resolved', decision = ?, actor = ?, reason = ?, request_id = ?,
             request_payload_hash = ?, event_payload_hash = ?, resolved_at = ?
         WHERE review_id = ? AND state = 'pending' AND changes() = 1`,
    )
    .bind(
      input.decision,
      actor,
      input.reason,
      input.requestId,
      payloadHash,
      prepared.eventPayloadHash,
      now,
      reviewId,
    );
  const alertStatement = db
    .prepare(
      `UPDATE forecast_ops_alerts
         SET state = 'resolved', resolved_at = ?, next_send_at = ?
         WHERE alert_key = ? AND state = 'open' AND changes() = 1
           AND EXISTS (
             SELECT 1 FROM source_manual_reviews
             WHERE review_id = ? AND state = 'resolved'
               AND request_id = ? AND request_payload_hash = ?
           )`,
    )
    .bind(
      now,
      now,
      manualReviewAlertKey(environment, review.source, review.item_id),
      reviewId,
      input.requestId,
      payloadHash,
    );
  // Keep queue, review, and alert adjacent: changes() gates each on this batch's
  // immediately preceding decision write, not a historical matching request.
  const statements = [
    ...prepared.priorStatements,
    prepared.queueStatement,
    reviewStatement,
    alertStatement,
  ];
  const results = await db.batch(statements);
  const queueChanges = Number(results.at(-3)?.meta.changes ?? 0);
  const reviewChanges = Number(results.at(-2)?.meta.changes ?? 0);
  if (queueChanges !== 1 || reviewChanges !== 1) throw new Error("manual_review_decision_race");
  const stored = await readManualReview(db, reviewId, schema27Allowed);
  if (!stored) throw new Error("manual_review_missing_after_decision");
  return { review: stored, candidateCreated: prepared.candidateCreated, idempotent: false };
}

function parseDecisionInput(raw: unknown) {
  const input = decisionInputSchema.parse(raw);
  if (input.decision === "manual_event" && input.event === null && !input.resolution) {
    throw new Error("manual_review_event_required");
  }
  if (input.decision !== "manual_event" && (input.event !== null || input.resolution)) {
    throw new Error("manual_review_event_forbidden");
  }
  return input;
}

async function readIdempotentDecision(
  db: D1Database,
  reviewId: string,
  requestId: string,
  payloadHash: string,
) {
  const existing = await db
    .prepare(
      "SELECT review_id, request_payload_hash FROM source_manual_reviews WHERE request_id = ?",
    )
    .bind(requestId)
    .first<{ review_id: string; request_payload_hash: string }>();
  if (!existing) return null;
  if (existing.review_id !== reviewId || existing.request_payload_hash !== payloadHash) {
    throw new Error("manual_review_request_conflict");
  }
  const stored = await readManualReview(db, reviewId);
  if (!stored) throw new Error("manual_review_missing_after_idempotent_request");
  return { review: stored, candidateCreated: false, idempotent: true };
}

async function prepareManualReviewDecision(
  db: D1Database,
  review: ManualReviewRow,
  input: ManualReviewDecisionInput,
  now: string,
  nowMs: number,
  runtimeIngestion: boolean,
  schema27Allowed: () => Promise<boolean>,
): Promise<PreparedManualReviewDecision> {
  if (review.source === "naver-board-11" || input.resolution) {
    if (!(await schema27Allowed())) throw new Error("board11_schema_required");
  }
  if (input.resolution) {
    const prepared = await prepareTypedResolution(
      db,
      review.review_id,
      input.resolution,
      manualReviewWriteCondition(review),
      now,
      schema27Allowed,
    );
    review.writeCondition = prepared.guard;
    return {
      priorStatements: prepared.statements,
      queueStatement: queueDecisionStatement(db, review, "processed", now),
      candidateCreated: false,
      eventPayloadHash: await sha256Hex(stableJson(input.resolution)),
    };
  }
  if (input.decision === "requeue") {
    return {
      priorStatements: [],
      queueStatement: queueDecisionStatement(db, review, "pending", now),
      candidateCreated: false,
      eventPayloadHash: null,
    };
  }
  if (input.decision === "ignore") {
    return {
      priorStatements: [],
      queueStatement: queueDecisionStatement(db, review, "ignored", now),
      candidateCreated: false,
      eventPayloadHash: null,
    };
  }
  if (!input.event) throw new Error("manual_review_event_required");
  return prepareManualEventDecision(db, review, input.event, now, nowMs, runtimeIngestion);
}

async function prepareManualEventDecision(
  db: D1Database,
  review: ManualReviewRow,
  eventInput: NonNullable<ManualReviewDecisionInput["event"]>,
  now: string,
  nowMs: number,
  runtimeIngestion: boolean,
): Promise<PreparedManualReviewDecision> {
  const sourceItem = await loadManualSourceItem(db, review.source, review.item_id);
  const event = await manualScheduleEvent(sourceItem, eventInput);
  const condition = manualReviewWriteCondition(review);
  const priorStatements = sourceItemAndEventStatements(db, [sourceItem], [event], now, condition);
  if (runtimeIngestion) {
    const unresolved = await db
      .prepare(`SELECT 1 FROM source_queue
      WHERE status IN ('pending','manual_review') AND NOT (source=? AND item_id=?) LIMIT 1`)
      .bind(review.source, review.item_id)
      .first();
    const gameDay = gameDayKey(nowMs);
    const revision = await nextForecastRevision(db, gameDay);
    const candidate = unresolved
      ? undefined
      : await buildNoticeCandidate(
          await loadRuntimeEvents(db, await loadScheduleEvents(db)),
          [
            {
              source: review.source,
              itemId: review.item_id,
              outcome: "processed",
              item: sourceItem,
              event,
            },
          ],
          nowMs,
          revision,
        );
    if (candidate)
      priorStatements.push(
        ...candidateStatements(
          db,
          candidate.envelope,
          candidate.eventId,
          gameDay,
          revision,
          now,
          condition,
        ),
      );
    return {
      priorStatements,
      queueStatement: queueDecisionStatement(db, review, "processed", now),
      candidateCreated: Boolean(candidate),
      eventPayloadHash: await sha256Hex(stableJson(eventInput)),
    };
  }
  const scheduleEvents = [...(await loadScheduleEvents(db)), event];
  const resolved = resolveSoloSchedule(scheduleEvents, nowMs);
  if (resolved) {
    const gameDay = gameDayKey(nowMs);
    const revision = await nextForecastRevision(db, gameDay);
    const candidate = await buildForecastCandidate(
      resolved,
      scheduleEvents,
      { status: "x_unavailable", sourceItem: null, reason: "manual_review_decision" },
      nowMs,
      revision,
    );
    priorStatements.push(
      ...candidateStatements(db, candidate, event.eventId, gameDay, revision, now, condition),
    );
  }
  return {
    priorStatements,
    queueStatement: queueDecisionStatement(db, review, "processed", now),
    candidateCreated: resolved !== null,
    eventPayloadHash: await sha256Hex(stableJson(eventInput)),
  };
}

function manualReviewWriteCondition(review: ManualReviewRow): StatementWriteCondition {
  if (review.writeCondition) return review.writeCondition;
  return {
    sql: `EXISTS (
      SELECT 1 FROM source_manual_reviews r
      JOIN source_queue q ON q.source = r.source AND q.item_id = r.item_id
      WHERE r.review_id = ? AND r.source = ? AND r.item_id = ? AND r.generation = ?
        AND r.state = 'pending' AND q.status = 'manual_review'
        AND r.expires_at = ?
        AND q.review_generation = r.generation
    )`,
    bindings: [
      review.review_id,
      review.source,
      review.item_id,
      review.generation,
      review.expires_at,
    ],
  };
}

function queueDecisionStatement(
  db: D1Database,
  review: ManualReviewRow,
  target: "pending" | "ignored" | "processed",
  now: string,
) {
  const condition = manualReviewWriteCondition(review);
  if (target === "pending") {
    return db
      .prepare(
        `UPDATE source_queue SET status = 'pending', attempts = 0, error_code = NULL,
           review_generation = review_generation + 1, updated_at = ?
         WHERE source = ? AND item_id = ? AND status = 'manual_review'
           AND review_generation = ? AND (${condition.sql})`,
      )
      .bind(now, review.source, review.item_id, review.generation, ...condition.bindings);
  }
  return db
    .prepare(
      `UPDATE source_queue SET status = ?, updated_at = ?
       WHERE source = ? AND item_id = ? AND status = 'manual_review'
         AND review_generation = ? AND (${condition.sql})`,
    )
    .bind(target, now, review.source, review.item_id, review.generation, ...condition.bindings);
}

async function expireManualReviews(db: D1Database, nowMs: number) {
  const now = new Date(nowMs).toISOString();
  await db
    .prepare(
      `UPDATE source_manual_reviews SET state = 'expired', resolved_at = ?
       WHERE state = 'pending' AND expires_at <= ?
       AND (source<>'naver-board-11' OR EXISTS(SELECT 1 FROM schema_migrations WHERE version>=27))`,
    )
    .bind(now, now)
    .run();
}

function manualReviewAlertKey(
  environment: "staging" | "production",
  source: NaverSourceKind,
  itemId: string,
) {
  return `manual-review:${environment}:${source}:${itemId}`;
}

function reviewSelectSql() {
  return `SELECT r.*, q.url, q.title, q.published_at, q.error_code,
                 q.status AS queue_status
          FROM source_manual_reviews r
          JOIN source_queue q ON q.source = r.source AND q.item_id = r.item_id`;
}

function publicManualReview(row: ManualReviewRow) {
  return {
    reviewId: row.review_id,
    source: row.source,
    itemId: row.item_id,
    generation: Number(row.generation),
    state: row.state,
    decision: row.decision,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    sourceItem: {
      url: validatedNaverUrl(row.url),
      title: row.title,
      publishedAt: row.published_at,
      errorCode: row.error_code,
      queueStatus: row.queue_status,
    },
  };
}

async function loadManualSourceItem(
  db: D1Database,
  source: NaverSourceKind,
  itemId: string,
): Promise<NormalizedSourceItem> {
  const row = await db
    .prepare(
      `SELECT source, item_id, url, title, excerpt, published_at, content_hash,
              structured, official
       FROM source_items WHERE source = ? AND item_id = ?`,
    )
    .bind(source, itemId)
    .first<SourceItemRow>();
  if (row) {
    if (row.official !== 1) throw new Error("manual_review_source_contract_invalid");
    if (!/^[0-9a-f]{64}$/.test(row.content_hash)) {
      throw new Error("manual_review_source_hash_invalid");
    }
    return {
      source: row.source,
      itemId: row.item_id,
      url: validatedNaverUrl(row.url),
      title: row.title,
      excerpt: row.excerpt,
      normalizedText: `${row.title}\n${row.excerpt}`,
      publishedAt: row.published_at,
      contentHash: row.content_hash,
      structured: row.structured === 1,
      official: true,
    };
  }

  const queued = await db
    .prepare(
      `SELECT source, item_id, url, title, published_at, official
       FROM source_queue WHERE source = ? AND item_id = ?`,
    )
    .bind(source, itemId)
    .first<{
      source: NaverSourceKind;
      item_id: string;
      url: string;
      title: string;
      published_at: string;
      official: number;
    }>();
  if (queued?.official !== 1 || !Number.isFinite(Date.parse(queued.published_at))) {
    throw new Error("manual_review_source_contract_invalid");
  }
  const url = validatedNaverUrl(queued.url);
  const excerpt = "manual_review_metadata_only";
  const normalizedText = `${queued.title}\n${url}\n${queued.published_at}\n${excerpt}`;
  return {
    source: queued.source,
    itemId: queued.item_id,
    url,
    title: queued.title,
    excerpt,
    normalizedText,
    publishedAt: queued.published_at,
    contentHash: await sha256Hex(normalizedText),
    structured: false,
    official: true,
  };
}

async function manualScheduleEvent(
  sourceItem: NormalizedSourceItem,
  input: NonNullable<ManualReviewDecisionInput["event"]>,
): Promise<ScheduleEvent> {
  const startsAt = kstToUtc(input.startsAtKst);
  const endsAt = input.endsAtKst === null ? null : kstToUtc(input.endsAtKst);
  if (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new Error("manual_review_schedule_range_invalid");
  }
  if (input.eventType === "solo" && endsAt === null) {
    throw new Error("manual_review_solo_end_required");
  }
  const identity = await sha256Hex(
    stableJson({ source: sourceItem.source, itemId: sourceItem.itemId, ...input }),
  );
  return {
    eventId: `${sourceItem.source}:${sourceItem.itemId}:manual:${identity.slice(0, 20)}`,
    eventType: input.eventType,
    sourceItem,
    startsAt,
    endsAt,
    scheduleStatus: input.scheduleStatus,
    manualReview: false,
    reason: null,
  };
}

function kstToUtc(value: string) {
  if (!kstMinutePattern.test(value)) throw new Error("manual_review_kst_timestamp_invalid");
  const timestamp = `${value}:00+09:00`;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new Error("manual_review_kst_timestamp_invalid");
  const roundTrip = new Date(parsed + 9 * 60 * 60 * 1_000).toISOString().slice(0, 16);
  if (roundTrip !== value) throw new Error("manual_review_kst_timestamp_invalid");
  return new Date(parsed).toISOString();
}

function validatedNaverUrl(value: string) {
  const url = URL.parse(value);
  if (url?.protocol !== "https:" || url.hostname !== "game.naver.com") {
    throw new Error("manual_review_source_url_invalid");
  }
  return url.toString();
}

function gameDayKey(nowMs: number) {
  return new Date(nowMs + 4 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function boundedActor(value: string) {
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, 120);
  if (!normalized) throw new Error("manual_review_actor_invalid");
  return normalized;
}
