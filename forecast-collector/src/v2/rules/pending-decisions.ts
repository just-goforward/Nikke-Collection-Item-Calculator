import { applyScheduleDecision } from "./apply-decisions";
import { applyGrantDecision } from "./apply-grants";
import { type DecisionInput, decisionIdentity, hash, requestDecision } from "./decisions";

const terminalErrors = new Set([
  "decision_schedule_missing",
  "grant_correction_target_ambiguous",
  "grant_decision_observation_missing",
  "grant_decision_option_invalid",
  "schedule_decision_option_invalid",
  "schedule_decision_option_unsupported",
]);

/** One result per invocation; unexpected infrastructure failures remain retryable. */
export async function applyPendingDecisions(db: D1Database, clock: number) {
  const now = new Date(clock).toISOString();
  const row = await db
    .prepare(`SELECT q.decision_id,q.type,q.event_id,q.payload_json,r.result_json
    FROM forecast_v2_decision_requests q JOIN forecast_v2_decision_results r USING(decision_id)
    WHERE q.status='resolved' AND NOT EXISTS(
      SELECT 1 FROM forecast_v2_admin_commands c WHERE c.decision_id=q.decision_id)
    ORDER BY r.created_at,r.decision_id LIMIT 1`)
    .first<{
      decision_id: string;
      type: DecisionInput["type"];
      event_id: string | null;
      payload_json: string;
      result_json: string;
    }>();
  if (!row) return { applied: false };
  try {
    const applied = row.type.startsWith("grant_")
      ? await applyGrantDecision(db, now)
      : await applyScheduleDecision(db, now);
    return { applied };
  } catch (error) {
    if (!(error instanceof Error) || !terminalErrors.has(error.message)) throw error;
    const payload = JSON.parse(row.payload_json) as {
      env: DecisionInput["environment"];
      sourceHash: string;
      feedIds: number[];
      sourceVersion?: string;
      title: string;
      url: string;
      options: DecisionInput["options"];
      extracted?: DecisionInput["extracted"];
    };
    const result = JSON.parse(row.result_json) as { optionId?: string };
    const options = payload.options.filter((option) => option.id !== result.optionId);
    const exhaustedGrant = row.type.startsWith("grant_") && options.length === 0;
    if (!exhaustedGrant)
      await requestDecision(
        db,
        {
          id: await decisionIdentity("failed", row.decision_id),
          type: row.type,
          environment: payload.env,
          eventId: row.event_id,
          sourceHash: payload.sourceHash,
          feedIds: payload.feedIds,
          ...(payload.sourceVersion ? { sourceVersion: payload.sourceVersion } : {}),
          title: `${payload.title} (${error.message})`,
          url: payload.url,
          options,
          ...(payload.extracted && options.length ? { extracted: payload.extracted } : {}),
        },
        now,
      );
    await db.batch([
      ...(exhaustedGrant
        ? [
            db
              .prepare(`INSERT INTO forecast_ops_alerts
        (alert_key,environment,severity,component,error_code,state,context_json,first_seen_at,last_seen_at,next_send_at)
        VALUES(?,?,'warning','forecast_v2_rules','grant_decision_options_exhausted','open',?,?,?,?)
        ON CONFLICT(alert_key) DO NOTHING`)
              .bind(
                `grant_options_${row.decision_id}`,
                payload.env,
                JSON.stringify({
                  decisionId: row.decision_id,
                  type: row.type,
                  failure: error.message,
                  feedIds: payload.feedIds,
                  sourceVersion: payload.sourceVersion,
                }),
                now,
                now,
                now,
              ),
          ]
        : []),
      db
        .prepare(`INSERT INTO forecast_v2_admin_commands
        (command_id,idempotency_key,payload_hash,event_id,decision_id,expected_revision,created_at)
        VALUES(?,?,?,NULL,?,0,?) ON CONFLICT DO NOTHING`)
        .bind(
          `failed_${row.decision_id}`,
          row.decision_id,
          await hash(row.result_json),
          row.decision_id,
          now,
        ),
      db
        .prepare("UPDATE forecast_v2_decision_requests SET status='stale' WHERE decision_id=?")
        .bind(row.decision_id),
    ]);
    return { applied: false, failure: error.message };
  }
}
