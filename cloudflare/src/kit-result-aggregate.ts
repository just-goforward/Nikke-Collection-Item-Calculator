import type { Kit } from "../../shared/game";

export type LegacyKitContext = { grade: string; level: number; expBucket: number };
export type KitAggregateInput = LegacyKitContext & {
  dateKey: string; kit: Kit; recommendedUses: number;
  outcome: "great_success" | "no_great_success"; successAttempt: number | null;
  nowSeconds: number;
};
export type OutcomeEffectClaim = { reportId: string; nonce: string } & (
  { phase: "initial" } | { phase: "patch"; revision: number }
);

/** Unknown success attempts cannot contribute a numerator without its denominator.
 * The legacy input validation already guarantees positive attempts for old clients.
 */
export function kitResultAggregateStatement(
  db: Pick<D1Database, "prepare">,
  input: KitAggregateInput,
  claim?: OutcomeEffectClaim,
): D1PreparedStatement | null {
  const attempts = input.outcome === "great_success" ? input.successAttempt : input.recommendedUses;
  if (attempts === null) return null;
  const successAttempt = input.successAttempt ?? 0;
  const values: unknown[] = [
    input.dateKey, input.grade, input.level, input.expBucket, input.kit, input.recommendedUses,
    input.outcome, successAttempt, attempts, input.outcome === "great_success" ? 1 : 0, input.nowSeconds,
  ];
  const select = claim
    ? `SELECT ?,?,?,?,?,?,?,?,1,?,?,?
       WHERE EXISTS(SELECT 1 FROM outcome_effects WHERE report_id=? AND
       ${claim.phase === "initial" ? "initial_claim=? AND raw_admitted=0" : "patch_claim=? AND patch_revision=?"}
       AND legacy_settled=0)`
    : "VALUES(?,?,?,?,?,?,?,?,1,?,?,?)";
  if (claim) values.push(claim.reportId, claim.nonce);
  if (claim?.phase === "patch") values.push(claim.revision);
  return db.prepare(
    `INSERT INTO event_aggregates_game_day
     (date_key,grade,level,exp_bucket,kit,recommended_uses,outcome,success_attempt,events,attempts,great_successes,last_seen)
     ${select}
     ON CONFLICT(date_key,grade,level,exp_bucket,kit,recommended_uses,outcome,success_attempt)
     DO UPDATE SET events=events+1,attempts=attempts+excluded.attempts,
       great_successes=great_successes+excluded.great_successes,last_seen=excluded.last_seen`,
  ).bind(...values);
}
