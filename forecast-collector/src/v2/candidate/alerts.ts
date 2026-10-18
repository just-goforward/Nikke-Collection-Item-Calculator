import { resolveOpsAlertsByPrefix, upsertOpsAlert } from "../../ops";
import type { CollectorEnv } from "../../types";
export type CandidateOutcome = { outcome: "built" | "unchanged" | "held"; reason?: string };

export async function candidateOutcome(env: CollectorEnv, now: number, result: CandidateOutcome) {
  const prefix = `v2-candidate:${env.ENVIRONMENT}:`;
  if (result.outcome !== "held") {
    await resolveOpsAlertsByPrefix(env.FORECAST_DB, prefix, now);
  } else {
    const key = `${prefix}${result.reason}`;
    await upsertOpsAlert(env.FORECAST_DB, {
      alertKey: key,
      environment: env.ENVIRONMENT === "production" ? "production" : "staging",
      component: "forecast-v2-candidate",
      errorCode: result.reason ?? "candidate_held",
      severity: "warning",
      nowMs: now,
      guard: {
        sql: "NOT EXISTS(SELECT 1 FROM forecast_ops_alerts WHERE alert_key=? AND state='open')",
        bindings: [key],
      },
    });
  }
  return result;
}
