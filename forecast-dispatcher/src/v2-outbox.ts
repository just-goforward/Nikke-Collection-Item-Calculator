import { readBoundedBytes } from "../../shared/boundedHttp.ts";
import { persistedErrorCode } from "../../shared/errorCodes.ts";
import { publicationHash } from "../../shared/forecastPublication.ts";
import {
  type ForecastV2NotificationKind,
  renderForecastV2Notification,
} from "../../shared/forecastV2Notifications.ts";
import { sha256Hex } from "./crypto.ts";
import { raiseOpsAlert } from "./db.ts";
import {
  DiscordMessageError,
  discordAmbiguous,
  discordRetryable,
  resolveDiscordChannelId,
  sendDiscordMessage,
} from "./discord.ts";
import type { DispatcherEnv } from "./types.ts";

// Five delivery attempts plus at most five recovery-only attempts.
const MAX_TOTAL_ATTEMPTS = 10;

export async function drainV2Outbox(env: DispatcherEnv) {
  if (env.FORECAST_V2_NOTIFICATIONS_ENABLED !== "true") return 0;
  const db = env.FORECAST_DB,
    now = Date.now();
  const rows = await db
    .prepare(`SELECT o.*,d.expected_calendar_revision FROM forecast_v2_notification_outbox o
    LEFT JOIN forecast_v2_decision_requests d ON d.decision_id=o.decision_id
    WHERE o.next_attempt_at<=? AND (o.state='pending' OR (o.state='sending' AND o.lease_until<=?))
    ORDER BY o.next_attempt_at LIMIT 1`)
    .bind(now, now)
    .all<{
      outbox_id: string;
      kind: ForecastV2NotificationKind;
      payload_json: string;
      payload_hash: string;
      idempotency_key: string;
      channel_role: "approval" | "activity";
      attempts: number;
      expected_calendar_revision: number | null;
    }>();
  let sent = 0;
  for (const row of rows.results) {
    const lease = crypto.randomUUID();
    const claimed = await db
      .prepare(`UPDATE forecast_v2_notification_outbox SET state='sending',attempts=attempts+1,lease_token=?,lease_until=?
      WHERE outbox_id=? AND (state='pending' OR (state='sending' AND lease_until<=?))`)
      .bind(lease, now + 60000, row.outbox_id, now)
      .run();
    if (claimed.meta.changes !== 1) continue;
    let phase: "render" | "delivery" | "commit" = "render";
    try {
      if ((await sha256Hex(row.payload_json)) !== row.payload_hash)
        throw new DiscordMessageError("v2_payload_hash", false);
      if (row.kind !== "calendar_changed" && row.expected_calendar_revision === null)
        throw new DiscordMessageError("v2_decision_missing", false);
      const payload = renderForecastV2Notification(row.kind, JSON.parse(row.payload_json), {
        environment: env.ENVIRONMENT,
        expectedRevision: row.expected_calendar_revision ?? 0,
        idempotencyKey: row.idempotency_key,
      });
      const channelId = resolveDiscordChannelId(env, row.channel_role);
      phase = "delivery";
      let messageId: string | undefined;
      if (row.attempts > 0) {
        messageId = await findDeliveredMessage(env, channelId, row.idempotency_key);
      }
      if (!messageId) {
        if (row.attempts >= 5) throw new DiscordMessageError("v2_delivery_exhausted", false);
        const message = {
          ...payload,
          nonce: (await publicationHash(row.idempotency_key)).slice(0, 24),
          enforce_nonce: true,
        };
        messageId = await sendWithImmediateRetry(env, row.channel_role, message);
      }
      phase = "commit";
      const committed = await db
        .prepare(
          `UPDATE forecast_v2_notification_outbox SET state='sent',message_id=?,channel_id=?,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE outbox_id=? AND lease_token=?`,
        )
        .bind(messageId, channelId, row.outbox_id, lease)
        .run();
      if (committed.meta.changes !== 1) throw new Error("v2_lease_lost");
      sent++;
    } catch (error) {
      await recordDeliveryFailure(env, row, lease, now, error, phase);
    }
  }
  return sent;
}

async function recordDeliveryFailure(
  env: DispatcherEnv,
  row: { attempts: number; outbox_id: string },
  lease: string,
  now: number,
  error: unknown,
  phase: "render" | "delivery" | "commit",
) {
  const db = env.FORECAST_DB;
  const retry = phase !== "render" && (discordRetryable(error) || discordAmbiguous(error));
  const reconcile = phase === "commit" || (phase === "delivery" && discordAmbiguous(error));
  const exhausted = row.attempts + 1 >= MAX_TOTAL_ATTEMPTS;
  if (exhausted) await alertReconciliationExhausted(env, row.outbox_id, now);
  if (phase === "render")
    console.error(JSON.stringify({ event: "v2_notification_invalid", outboxId: row.outbox_id }));
  const recorded = await db
    .prepare(
      `UPDATE forecast_v2_notification_outbox SET state=?,next_attempt_at=?,error_code=?,lease_token=NULL,lease_until=NULL WHERE outbox_id=? AND lease_token=?`,
    )
    .bind(
      !exhausted && (reconcile || (retry && row.attempts < 4)) ? "pending" : "dead",
      now + Math.max(60000, error instanceof DiscordMessageError ? (error.retryAfterMs ?? 0) : 0),
      exhausted ? "v2_reconciliation_exhausted" : deliveryErrorCode(error),
      row.outbox_id,
      lease,
    )
    .run();
  // Losing the lease means another drain owns the row now; say so instead of
  // assuming this failure was persisted.
  if (recorded.meta.changes !== 1)
    console.warn(
      JSON.stringify({
        event: "v2_delivery_failure_not_recorded",
        outboxId: row.outbox_id,
        code: "lease_lost",
      }),
    );
}

function deliveryErrorCode(error: unknown) {
  // Persisted verbatim and later rendered in an ops alert, so only a registered code
  // (or the fixed v2 delivery fallback) reaches D1 instead of a driver message or a
  // runtime error name.
  return persistedErrorCode(error, "v2_delivery");
}

async function alertReconciliationExhausted(env: DispatcherEnv, outboxId: string, now: number) {
  await raiseOpsAlert(env.FORECAST_DB, {
    alertKey: `v2-reconciliation:${outboxId}`,
    environment: env.ENVIRONMENT,
    severity: "critical",
    component: "forecast-dispatcher",
    errorCode: "v2_reconciliation_exhausted",
    context: { outboxId },
    nowMs: now,
  });
}

async function findDeliveredMessage(
  env: DispatcherEnv,
  channelId: string,
  idempotencyKey: string,
): Promise<string | undefined> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`,
    {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok)
    throw new DiscordMessageError(
      `v2_reconcile_${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  const messages: unknown = JSON.parse(
    new TextDecoder().decode(await readBoundedBytes(response, 512000, "v2_reconcile_too_large")),
  );
  if (!Array.isArray(messages)) throw new Error("v2_reconcile_invalid");
  return messages.find((m) =>
    m.embeds?.some(
      (e: { footer?: { text?: string } }) => e.footer?.text === `ref:${idempotencyKey}`,
    ),
  )?.id;
}

async function sendWithImmediateRetry(
  env: DispatcherEnv,
  channelRole: "approval" | "activity",
  message: object,
) {
  const started = Date.now();
  try {
    return (await sendDiscordMessage(env, channelRole, message)).messageId;
  } catch (error) {
    if (!discordAmbiguous(error) || Date.now() - started >= 60000) throw error;
    return (await sendDiscordMessage(env, channelRole, message)).messageId;
  }
}
