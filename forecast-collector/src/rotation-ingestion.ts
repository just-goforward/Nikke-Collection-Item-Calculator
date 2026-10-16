import { runRuntimeIngestion } from "./runtime-ingestion";
import { finishInvocation, startInvocation } from "./source-queue";
import type { CollectorEnv } from "./types";

export async function runRotationIngestion(env: CollectorEnv, scheduledTime: number) {
  const id = await startInvocation(
    env.FORECAST_DB,
    env.DEPLOY_SHA,
    scheduledTime,
    env.POLL_MODE,
    "",
    null,
  );
  if (id === null) return { outcome: "duplicate" as const };
  try {
    const result = await runRuntimeIngestion(env, { requireRotationAdmission: true });
    // This is cron delivery/slot completion evidence, not collection success.
    await finishInvocation(env.FORECAST_DB, id, "completed", 0, null, null);
    return result;
  } catch (error) {
    await finishInvocation(env.FORECAST_DB, id, "failure", 0, "rotation_ingestion_failed", null);
    throw error;
  }
}
