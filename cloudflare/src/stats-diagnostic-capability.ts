import type {
  DeliveryAggregateRow, DiagnosticObservations, FailureAggregateRow, RejectionAggregateRow,
} from "./stats-capability-contract";
import type { WorkerEnv } from "./env";
import { HttpError } from "./http-error";
import { assertQuotaAllows } from "./quota-guard";

export type { DiagnosticObservations } from "./stats-capability-contract";

/** A role-specific operation, not a table selector or SQL transport. The 501st row
 * is an overflow sentinel consumed by Observer, not silent truncation to 500.
 */
export async function readDiagnosticObservations(env: WorkerEnv, cutoff: number): Promise<DiagnosticObservations> {
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > Math.floor(Date.now() / 1000))
    throw new HttpError(400, "invalid_payload");
  await assertQuotaAllows(env, "statistics_read");
  const db = env.DB.withSession("first-primary");
  const results = await db.batch([
    db.prepare(
      `SELECT * FROM solver_failure_aggregates_game_day WHERE last_seen>=? ORDER BY last_seen ASC LIMIT 501`,
    ).bind(cutoff),
    db.prepare(
      `SELECT * FROM stats_submission_rejection_aggregates_game_day WHERE last_seen>=? ORDER BY last_seen ASC LIMIT 501`,
    ).bind(cutoff),
    db.prepare(
      `SELECT * FROM stats_delivery_health_aggregates_game_day WHERE last_seen>=? ORDER BY last_seen ASC LIMIT 501`,
    ).bind(cutoff),
  ]);
  return {
    failures: results[0]!.results as FailureAggregateRow[],
    rejections: results[1]!.results as RejectionAggregateRow[],
    delivery: results[2]!.results as DeliveryAggregateRow[],
  };
}
