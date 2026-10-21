import {
  expireBudgetIncidents,
  listDueAlerts,
  markAlertSendFailed,
  markAlertSent,
  retireLegacyBudgetAlerts,
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
  // Budget incidents live exactly as long as their game day: close the ended ones
  // silently here (this runs every few minutes), and retire the legacy per-stream
  // keys so their pending renewals stop without a data migration.
  await expireBudgetIncidents(db, env.ENVIRONMENT, now);
  await retireLegacyBudgetAlerts(db, env.ENVIRONMENT, now);
  let sent = 0;
  for (const alert of await listDueAlerts(db, env.ENVIRONMENT, now)) {
    try {
      const payload =
        alert.state === "resolved" ? await opsRecoveryMessage(alert) : await opsAlertMessage(alert);
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
