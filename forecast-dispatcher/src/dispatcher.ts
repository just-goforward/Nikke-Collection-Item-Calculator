import {
  CERTIFIED_EVIDENCE_COVERAGE,
  type CertifiedEvidenceCoverage,
} from "../../shared/certifiedEvidenceCoverage.ts";
import { errorCode, persistedErrorCode } from "../../shared/errorCodes.ts";
import {
  createPreviousRollbackReview,
  createReview,
  initializePublication,
  type ReviewRow,
  readActive,
  readSealedCandidate,
} from "../../shared/forecast-publication/store.ts";
import { publicationHash } from "../../shared/forecastPublication.ts";
import { readBoundedText } from "../../shared/boundedHttp.ts";
import { admitCandidates } from "./admission.ts";
import { DiscordMessageError, discordRetryable, resolveDiscordChannelId, sendDiscordMessage } from "./discord.ts";
import { flushOperations } from "./operations.ts";
import {
  loadReviewCompetition,
  publicationResultContent,
  publicationReviewPayload,
} from "./publication-review-message.ts";
import type { DispatcherEnv } from "./types.ts";
import { drainV2Outbox } from "./v2-outbox.ts";

const LEASE_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 5;
type OutboxRow = {
  outbox_id: string;
  kind: "review" | "result";
  review_id: string;
  operation_id: string | null;
  attempts: number;
  channel_id: string | null;
};

/** Only D1 -> Discord. No legacy queue mutations or GitHub workflow dispatch. */
async function isolatedV2Drain(env: DispatcherEnv) {
  try {
    return await drainV2Outbox(env);
  } catch (error) {
    // The v2 outbox is isolated from operational delivery, but its failure still gets a
    // typed code so a broken drain is diagnosable instead of a bare event. Only
    // registered codes are logged; raw `Error.message` would leak whatever the driver
    // quoted back to us.
    console.error(
      JSON.stringify({
        event: "v2_outbox_drain_failed",
        code: errorCode(error),
      }),
    );
    return 0;
  }
}

export async function runDispatcher(
  env: DispatcherEnv,
  _options: { scheduledTime?: number } = {},
  coverage: readonly CertifiedEvidenceCoverage[] = CERTIFIED_EVIDENCE_COVERAGE,
) {
  if (env.DISPATCH_ENABLED !== "true") return { status: "disabled", sent: 0 };
  const operationsSent = (await flushOperations(env)) + (await isolatedV2Drain(env));
  if (env.PUBLICATION_MODE !== "enabled") return { status: "completed", sent: operationsSent };
  const db = env.FORECAST_DB;
  const now = Date.now();
  const active = await initializePublication(db, env.ENVIRONMENT);
  try {
    // Separate the costly new seal from a backlog of hash-checked deliveries.
    // Delivery takes priority; a fresh candidate is admitted on the next idle pass.
    const deliveryDue = await db
      .prepare(`SELECT outbox_id FROM forecast_runtime_outbox
      WHERE environment=? AND attempts<? AND next_attempt_at<=?
        AND (state='pending' OR (state='sending' AND lease_until<=?)) LIMIT 1`)
      .bind(env.ENVIRONMENT, MAX_ATTEMPTS, now, now)
      .first();
    if (!deliveryDue) await admitCandidates(db, active, now, coverage);
    if (active.sequence > 0 && active.candidate_id)
      await createReview(db, active, "off", null, null, now);
    await createPreviousRollbackReview(db, active, now, undefined, coverage);
  } catch (error) {
    // A concurrent activation can stale this snapshot. Existing outbox deliveries
    // (especially committed results) must still proceed.
    console.warn(
      JSON.stringify({ event: "publication_review_failed", code: errorCode(error, "publication") }),
    );
  }
  const due = await db
    .prepare(`SELECT outbox_id,kind,review_id,operation_id,attempts,channel_id FROM forecast_runtime_outbox
    WHERE environment=? AND attempts<? AND next_attempt_at<=?
      AND (state='pending' OR (state='sending' AND lease_until<=?))
    ORDER BY next_attempt_at,outbox_id LIMIT ?`)
    .bind(env.ENVIRONMENT, MAX_ATTEMPTS, now, now, BATCH_SIZE)
    .all<OutboxRow>();
  // An interrupted final attempt must not remain leased forever.
  await db
    .prepare(`UPDATE forecast_runtime_outbox SET state='dead',error_code='publication_delivery_exhausted',
    lease_token=NULL,lease_until=NULL WHERE environment=? AND state='sending' AND lease_until<=? AND attempts>=?`)
    .bind(env.ENVIRONMENT, now, MAX_ATTEMPTS)
    .run();
  let sent = operationsSent;
  for (const row of due.results) {
    const lease = crypto.randomUUID();
    const claimed = await db
      .prepare(`UPDATE forecast_runtime_outbox SET state='sending',attempts=attempts+1,lease_token=?,lease_until=?
      WHERE outbox_id=? AND environment=? AND attempts<? AND next_attempt_at<=?
        AND (state='pending' OR (state='sending' AND lease_until<=?))`)
      .bind(lease, now + LEASE_MS, row.outbox_id, env.ENVIRONMENT, MAX_ATTEMPTS, now, now)
      .run();
    if (claimed.meta.changes !== 1) continue;
    try {
      // Human publication results belong on the original interaction message.
      // A failed interaction PATCH leaves a bounded original-message repair job,
      // never a second activity notification. Automatic events are unaffected.
      if (row.kind === "result") {
        const human = await db
          .prepare("SELECT interaction_id FROM forecast_runtime_commands WHERE interaction_id=? AND state='applied'")
          .bind(row.operation_id)
          .first();
        if (human) {
          await repairPublicationMessage(db, env, row, now);
          const consumed = await db
            .prepare(`UPDATE forecast_runtime_outbox SET state='sent',lease_token=NULL,lease_until=NULL,error_code=NULL
              WHERE outbox_id=? AND state='sending' AND lease_token=?`)
            .bind(row.outbox_id, lease)
            .run();
          if (consumed.meta.changes !== 1) throw new Error("publication_delivery_lease_lost");
          continue;
        }
      }
      const message = await outboxMessage(db, row, now);
      if (!message) {
        await finishDelivery(db, row.outbox_id, lease, "dead", "publication_review_stale", now);
        continue;
      }
      const nonce = (await publicationHash(row.outbox_id)).slice(0, 24);
      // Legacy result attempts have no pre-send channel binding or reconciliation
      // marker. Fail closed instead of potentially duplicating them across channels.
      const channelKind = row.kind === "review" ? "approval" : "activity";
      const channelId = resolveDiscordChannelId(env, channelKind);
      if (row.attempts > 0 && row.channel_id !== channelId)
        throw new DiscordMessageError("publication_delivery_exhausted", false);
      const bound = await db
        .prepare("UPDATE forecast_runtime_outbox SET channel_id=? WHERE outbox_id=? AND lease_token=?")
        .bind(channelId, row.outbox_id, lease)
        .run();
      if (bound.meta.changes !== 1) throw new Error("publication_delivery_lease_lost");
      const result = await sendDiscordMessage(env, channelKind, {
        ...message,
        nonce,
        enforce_nonce: true,
        allowed_mentions: { parse: [] },
      });
      const changed = await db
        .prepare(`UPDATE forecast_runtime_outbox SET state='sent',message_id=?,channel_id=?,
        lease_token=NULL,lease_until=NULL,error_code=NULL WHERE outbox_id=? AND state='sending' AND lease_token=?`)
        .bind(result.messageId, result.channelId, row.outbox_id, lease)
        .run();
      if (changed.meta.changes !== 1) throw new Error("publication_delivery_lease_lost");
      sent += 1;
    } catch (error) {
      const retryable = discordRetryable(error);
      const retryAfter =
        error instanceof DiscordMessageError ? (error.retryAfterMs ?? RETRY_MS) : RETRY_MS;
      await finishDelivery(
        db,
        row.outbox_id,
        lease,
        retryable && row.attempts + 1 < MAX_ATTEMPTS ? "pending" : "dead",
        // Persisted on the row and later rendered in an ops alert: a registered code or
        // the fixed publication fallback, never a driver message or a runtime error name.
        persistedErrorCode(error, "publication"),
        now + Math.max(RETRY_MS, retryAfter),
      );
    }
  }
  return { status: "completed", sent };
}

async function repairPublicationMessage(db: D1Database, env: DispatcherEnv, row: OutboxRow, now: number) {
  const binding = await db.prepare(`SELECT message_id,channel_id FROM forecast_runtime_outbox
    WHERE kind='review' AND review_id=? AND environment=? AND state='sent'`)
    .bind(row.review_id, env.ENVIRONMENT)
    .first<{ message_id: string; channel_id: string }>();
  const channelId = resolveDiscordChannelId(env, "approval");
  if (!binding || binding.channel_id !== channelId || !/^\d{6,24}$/.test(binding.message_id))
    throw new DiscordMessageError("publication_review_binding", false);
  if (!env.DISCORD_BOT_TOKEN) throw new DiscordMessageError("discord_bot_token_missing", false);
  // Several emergency actions may share the message: repair its latest committed
  // outcome, not an older outbox result that would overwrite a newer success.
  const applied = await db.prepare(`SELECT h.environment,h.action,h.sequence,h.candidate_id,h.operation_id,h.applied_at
    FROM forecast_runtime_activation_history h JOIN forecast_runtime_outbox o
    ON o.review_id=h.review_id AND o.kind='review'
    WHERE o.message_id=? AND o.channel_id=? AND h.environment=?
    ORDER BY h.sequence DESC LIMIT 1`)
    .bind(binding.message_id, channelId, env.ENVIRONMENT)
    .first<{ environment: string; action: string; sequence: number; candidate_id: string | null; operation_id: string; applied_at: number }>();
  if (!applied) throw new DiscordMessageError("publication_result_missing", false);
  const controls = await db.prepare(`SELECT r.review_id,r.action FROM forecast_runtime_reviews r
    JOIN forecast_runtime_outbox o ON o.review_id=r.review_id AND o.kind='review'
    JOIN forecast_runtime_active a ON a.environment=r.environment AND a.sequence=r.expected_sequence
      AND a.candidate_id IS r.previous_candidate_id
    WHERE o.state='sent' AND o.message_id=? AND o.channel_id=? AND r.environment=? AND r.expires_at>?
      AND NOT EXISTS(SELECT 1 FROM forecast_runtime_activation_history h WHERE h.review_id=r.review_id)
    ORDER BY r.review_id LIMIT 5`)
    .bind(binding.message_id, channelId, env.ENVIRONMENT, now)
    .all<{ review_id: string; action: "approve" | "rollback" | "off" }>();
  const timestamp = `\n처리 기록: ${new Date(applied.applied_at + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")} KST`;
  const content = publicationResultContent({ ...applied, operationId: applied.operation_id });
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${binding.message_id}`, {
    method: "PATCH",
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      content: content.slice(0, 2000 - timestamp.length) + timestamp,
      components: controls.results.length ? [{ type: 1, components: controls.results.map((review) => ({
        type: 2, style: 4, label: `${{ approve: "승인", rollback: "롤백", off: "끄기" }[review.action]} 확인 (${env.ENVIRONMENT})`,
        custom_id: `forecast_publish:${env.ENVIRONMENT}:${review.review_id}`,
      })) }] : [],
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(8000),
  });
  // Bound all response work, including retry responses. The existing outbox cap,
  // lease and five-minute backoff apply; never POST on any failure.
  await readBoundedText(response, 16_384, "discord_response_too_large");
  if (!response.ok)
    throw new DiscordMessageError("publication_discord_response_failed", response.status === 429 || response.status >= 500);
}

async function finishDelivery(
  db: D1Database,
  id: string,
  lease: string,
  state: "pending" | "dead",
  code: string,
  next: number,
) {
  const changed = await db
    .prepare(`UPDATE forecast_runtime_outbox SET state=?,error_code=?,next_attempt_at=?,
    lease_token=NULL,lease_until=NULL WHERE outbox_id=? AND state='sending' AND lease_token=?`)
    .bind(state, code, next, id, lease)
    .run();
  if (changed.meta.changes !== 1) throw new Error("publication_delivery_lease_lost");
}

async function outboxMessage(db: D1Database, row: OutboxRow, now: number) {
  if (row.kind === "result") {
    const result = await db
      .prepare(`SELECT environment,action,sequence,candidate_id FROM forecast_runtime_activation_history
      WHERE operation_id=?`)
      .bind(row.operation_id)
      .first<{
        environment: string;
        action: string;
        sequence: number;
        candidate_id: string | null;
      }>();
    if (!result) throw new Error("publication_result_missing");
    return {
      content: publicationResultContent({ ...result, operationId: row.operation_id ?? "unknown" }),
    };
  }
  const review = await db
    .prepare(`SELECT r.* FROM forecast_runtime_reviews r JOIN forecast_runtime_active a
    ON a.environment=r.environment AND a.sequence=r.expected_sequence AND a.candidate_id IS r.previous_candidate_id
    WHERE r.review_id=? AND r.expires_at>? AND NOT EXISTS(
      SELECT 1 FROM forecast_runtime_activation_history h WHERE h.review_id=r.review_id)`)
    .bind(row.review_id, now)
    .first<ReviewRow & { created_at: number }>();
  if (!review) return null;
  const candidate = review.candidate_id ? await readSealedCandidate(db, review.candidate_id) : null;
  if (candidate && candidate.hash !== review.payload_hash)
    throw new Error("publication_candidate_hash");
  const active = await readActive(db, review.environment);
  // The operator-facing diff needs the candidate the site shows now. It is read for
  // comparison only; a known-missing artifact degrades the diff, never the delivery.
  const activeCandidate = active.candidate_id
    ? await readActiveCandidateForMessage(db, active.candidate_id)
    : null;
  return publicationReviewPayload({
    review,
    active,
    candidate: candidate?.candidate ?? null,
    activeCandidate,
    competition: await loadReviewCompetition(db, review, now),
    now,
  });
}

/**
 * A candidate that is no longer sealed must not block an approval request that is still
 * valid, so this one lookup degrades instead of throwing. The reason is logged with its
 * registered code; any other failure propagates because it is not a known absence.
 */
async function readActiveCandidateForMessage(db: D1Database, candidateId: string) {
  try {
    return (await readSealedCandidate(db, candidateId)).candidate;
  } catch (error) {
    const code = errorCode(error, "publication");
    if (
      code !== "publication_candidate_unsealed" &&
      code !== "publication_candidate_missing" &&
      code !== "publication_candidate_hash" &&
      !(error instanceof SyntaxError)
    )
      throw error;
    console.warn(
      JSON.stringify({ event: "publication_review_active_candidate_unknown", code, candidateId }),
    );
    return null;
  }
}
