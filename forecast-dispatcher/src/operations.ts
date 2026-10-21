import { errorCode, persistedErrorCode } from "../../shared/errorCodes.ts";
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
import type { DispatcherEnv, OpsAlertRow } from "./types.ts";

/** D1-only operational delivery, independent of publication mode. No workflow dispatch. */
export async function flushOperations(env: DispatcherEnv): Promise<number> {
  const db = env.FORECAST_DB;
  const now = Date.now();
  // Budget incidents live exactly as long as their game day: close the ended ones
  // silently here (this runs every few minutes), and retire the legacy per-stream
  // keys so their pending renewals stop without a data migration. The sweep stops
  // itself after `LEGACY_BUDGET_SUNSET_MS`.
  await expireBudgetIncidents(db, env.ENVIRONMENT, now);
  await retireLegacyBudgetAlerts(db, env.ENVIRONMENT, now);
  let sent = 0;
  for (const alert of await listDueAlerts(db, env.ENVIRONMENT, now)) {
    if (await deliverAlert(env, alert, now)) sent += 1;
  }
  return sent;
}

/** One alert's outcome stays contained: a D1 failure must not abort the rest. */
async function deliverAlert(env: DispatcherEnv, alert: OpsAlertRow, now: number) {
  const db = env.FORECAST_DB;
  let messageId: string;
  try {
    const payload =
      alert.state === "resolved" ? await opsRecoveryMessage(alert) : await opsAlertMessage(alert);
    messageId = (await sendDiscordMessage(env, "alert", payload)).messageId;
  } catch (error) {
    // A failed delivery stays durable on the row (retry deadline + error code). The
    // update can match no row when the alert moved on meanwhile; report that rather
    // than assuming the failure was recorded. A D1 error here is contained per alert:
    // the remaining alerts and later phases of this tick must still run.
    const code = await recordOutcome(() =>
      markAlertSendFailed(
        db,
        alert,
        persistedErrorCode(error, "ops_alert_delivery"),
        now,
        error instanceof DiscordMessageError ? (error.retryAfterMs ?? undefined) : undefined,
      ),
    );
    if (code)
      console.warn(
        JSON.stringify({
          event: "forecast_ops_send_failure_not_recorded",
          alertKey: alert.alertKey,
          code,
        }),
      );
    return false;
  }
  // The message exists: if its delivery cannot be recorded the alert would be sent
  // again, so this is reported loudly and never counted as sent.
  const code = await recordOutcome(() => markAlertSent(db, alert, messageId, now));
  if (code) {
    console.error(
      JSON.stringify({
        event: "forecast_ops_send_result_not_recorded",
        alertKey: alert.alertKey,
        messageId,
        code,
      }),
    );
    return false;
  }
  return true;
}

/**
 * `undefined` when exactly one row was recorded, else an allowlisted reason the
 * write did not land. A D1 error at this point is reported, never rethrown: one
 * alert's bookkeeping must not abort the remaining alerts or later phases.
 */
async function recordOutcome(write: () => Promise<number>) {
  try {
    return (await write()) === 1 ? undefined : "stale_row";
  } catch (error) {
    return errorCode(error, "ops_record");
  }
}
