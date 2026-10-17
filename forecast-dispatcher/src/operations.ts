import {
  listDueAlerts,
  markAlertSendFailed,
  markAlertSent,
  raiseOpsAlert,
  readManualReviewEvidence,
} from "./db.ts";
import {
  DiscordMessageError,
  opsAlertMessage,
  opsRecoveryMessage,
  sendDiscordMessage,
} from "./discord.ts";
import type { DispatcherEnv } from "./types.ts";

/** D1-only operational delivery, independent of publication mode. No workflow dispatch. */
export async function flushOperations(env: DispatcherEnv): Promise<number> {
  const db = env.FORECAST_DB;
  const now = Date.now();
  // Retained manual-review rows may predate their alert, or belong to a new generation.
  const manual = await db
    .prepare(`SELECT q.source,q.item_id,q.title,q.url,q.error_code,r.review_id
    FROM source_queue q JOIN source_manual_reviews r
      ON r.source=q.source AND r.item_id=q.item_id AND r.generation=q.review_generation
    LEFT JOIN forecast_ops_alerts a
      ON a.alert_key='manual-review:'||?||':'||q.source||':'||q.item_id
    WHERE q.status='manual_review' AND r.state='pending' AND r.expires_at>?
      AND (a.alert_key IS NULL OR json_extract(a.context_json,'$.reviewId') IS NOT r.review_id)
    ORDER BY q.updated_at,r.review_id LIMIT 5`)
    .bind(env.ENVIRONMENT, new Date(now).toISOString())
    .all<{
      source: string;
      item_id: string;
      title: string;
      url: string;
      error_code: string | null;
      review_id: string;
    }>();
  for (const row of manual.results)
    await raiseOpsAlert(db, {
      alertKey: `manual-review:${env.ENVIRONMENT}:${row.source}:${row.item_id}`,
      environment: env.ENVIRONMENT,
      severity: "warning",
      component: "source-queue",
      errorCode: "source_item_manual_review",
      context: {
        source: row.source,
        itemId: row.item_id,
        reviewId: row.review_id,
        title: row.title,
        url: row.url,
        reason: row.error_code,
      },
      nowMs: now,
    });
  let sent = 0;
  for (const alert of await listDueAlerts(db, env.ENVIRONMENT, now)) {
    try {
      const payload =
        alert.state === "resolved"
          ? await opsRecoveryMessage(alert)
          : await opsAlertMessage(alert, await readManualReviewEvidence(db, alert));
      const message = await sendDiscordMessage(env, "alert", payload);
      await markAlertSent(db, alert, message.messageId, now);
      sent += 1;
    } catch (error) {
      await markAlertSendFailed(
        db,
        alert,
        error instanceof Error ? error.message : "unknown",
        now,
        error instanceof DiscordMessageError ? (error.retryAfterMs ?? undefined) : undefined,
      );
    }
  }
  return sent;
}
