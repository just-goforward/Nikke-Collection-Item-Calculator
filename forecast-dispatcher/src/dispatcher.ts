import { errorCode, persistedErrorCode } from "../../shared/errorCodes.ts";
import {
  createPreviousRollbackReview,
  createReview,
  initializePublication,
  type ReviewRow,
  readSealedCandidate,
} from "../../shared/forecast-publication/store.ts";
import { publicationHash } from "../../shared/forecastPublication.ts";
import { admitCandidates } from "./admission.ts";
import { DiscordMessageError, discordRetryable, sendDiscordMessage } from "./discord.ts";
import { flushOperations } from "./operations.ts";
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

export async function runDispatcher(env: DispatcherEnv, _options: { scheduledTime?: number } = {}) {
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
    if (!deliveryDue) await admitCandidates(db, active, now);
    if (active.sequence > 0 && active.candidate_id)
      await createReview(db, active, "off", null, null, now);
    await createPreviousRollbackReview(db, active, now);
  } catch (error) {
    // A concurrent activation can stale this snapshot. Existing outbox deliveries
    // (especially committed results) must still proceed.
    console.warn(
      JSON.stringify({ event: "publication_review_failed", code: errorCode(error, "publication") }),
    );
  }
  const due = await db
    .prepare(`SELECT outbox_id,kind,review_id,operation_id,attempts FROM forecast_runtime_outbox
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
      const message = await outboxMessage(db, row, now);
      if (!message) {
        await finishDelivery(db, row.outbox_id, lease, "dead", "publication_review_stale", now);
        continue;
      }
      const nonce = (await publicationHash(row.outbox_id)).slice(0, 24);
      const result = await sendDiscordMessage(env, "approval", {
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
      content: `${result.environment}: ${result.action} committed at sequence ${result.sequence}.\nCandidate: ${result.candidate_id ?? "off"}\nCommand: ${row.operation_id}`,
    };
  }
  const review = await db
    .prepare(`SELECT r.* FROM forecast_runtime_reviews r JOIN forecast_runtime_active a
    ON a.environment=r.environment AND a.sequence=r.expected_sequence AND a.candidate_id IS r.previous_candidate_id
    WHERE r.review_id=? AND r.expires_at>? AND NOT EXISTS(
      SELECT 1 FROM forecast_runtime_activation_history h WHERE h.review_id=r.review_id)`)
    .bind(row.review_id, now)
    .first<ReviewRow>();
  if (!review) return null;
  let details = "";
  if (review.candidate_id) {
    const { candidate, hash } = await readSealedCandidate(db, review.candidate_id);
    if (hash !== review.payload_hash) throw new Error("publication_candidate_hash");
    details =
      `\nRules: ${candidate.rulesVersion}; payload: ${candidate.payloadVersion}; ledger: ${candidate.certifiedSnapshot!.version}` +
      `\nCoverage: ${candidate.certifiedSnapshot!.coverage.currentDay}` +
      `\nSources:\n${candidate.sourceEvidence
        .slice(0, 3)
        .map((source) => `${source.source}/${source.itemId}: ${source.url}`)
        .join("\n")}` +
      `\nWarnings: ${candidate.warnings.join("; ").slice(0, 600) || "none"}`;
  }
  return {
    content: (
      `${review.environment.toUpperCase()} forecast ${review.action}\nCandidate: ${review.candidate_id ?? "off"}` +
      `\nSHA-256: ${review.payload_hash ?? "none"}\nExpected sequence: ${review.expected_sequence}` +
      `\nExpires: ${new Date(review.expires_at).toISOString()}${details}`
    ).slice(0, 2000),
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: review.action === "approve" ? 3 : 4,
            label: `${review.action} (${review.environment})`,
            custom_id: `forecast_publish:${review.environment}:${review.review_id}`,
          },
        ],
      },
    ],
  };
}
