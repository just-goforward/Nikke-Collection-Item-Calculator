import { runRuntimeCandidate, runRuntimeIngestion } from "./runtime-ingestion";
import { finishInvocation, startInvocation } from "./source-queue";
import type { CollectorEnv } from "./types";

export async function runRotationIngestion(
  env: CollectorEnv,
  scheduledTime: number,
  candidateOnly = false,
  combined = false,
) {
  const id = await startInvocation(
    env.FORECAST_DB,
    env.DEPLOY_SHA,
    scheduledTime,
    env.POLL_MODE,
    combined ? "runtime-candidate:" : "",
    combined ? undefined : null,
  );
  if (id === null) return { outcome: "duplicate" as const };
  try {
    const result = candidateOnly
      ? await runRuntimeCandidate(env)
      : await runRuntimeIngestion(env, { requireRotationAdmission: true });
    // This is cron delivery/slot completion evidence, not collection success.
    await finishInvocation(env.FORECAST_DB, id, "completed", 0, null, null);
    return result;
  } catch (error) {
    await finishInvocation(env.FORECAST_DB, id, "failure", 0, "rotation_ingestion_failed", null);
    throw error;
  }
}
