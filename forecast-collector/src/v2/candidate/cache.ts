import type { SupplyForecastGrant } from "../../../../shared/supplyForecastCandidate";
import { sha256Hex, stableJson } from "../../crypto";
import type { CollectorEnv, ScheduleEvent } from "../../types";

export async function inputSignature(
  env: CollectorEnv,
  gameDay: string,
  events: ScheduleEvent[],
  grants: SupplyForecastGrant[],
  history?: unknown,
) {
  return `v2:${await sha256Hex(stableJson({ deploymentSha: env.DEPLOY_SHA, gameDay, events, grants, history }))}`;
}

export async function cachedInput(db: D1Database, signature: string) {
  return Boolean(
    await db
      .prepare(`SELECT 1 FROM runtime_candidate_cache c
    JOIN runtime_ingestion_runs r ON r.token=c.run_token
    JOIN forecast_candidates f ON f.candidate_id=c.candidate_id
    WHERE c.signature=? AND r.status='completed' AND c.payload_hash=f.payload_hash`)
      .bind(signature)
      .first(),
  );
}

export function cacheStatements(
  db: D1Database,
  signature: string,
  candidateId: string,
  payloadHash: string,
  now: number,
) {
  const token = `candidate:v2:${crypto.randomUUID()}`;
  const timestamp = new Date(now).toISOString();
  return [
    db
      .prepare(`INSERT INTO runtime_ingestion_runs
      (token,status,started_at,lease_until,finished_at,candidate_id)
      VALUES(?,'completed',?,?,?,?)`)
      .bind(token, timestamp, timestamp, timestamp, candidateId),
    db
      .prepare(`INSERT INTO runtime_candidate_cache VALUES(1,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET signature=excluded.signature,
      run_token=excluded.run_token,candidate_id=excluded.candidate_id,payload_hash=excluded.payload_hash`)
      .bind(signature, token, candidateId, payloadHash),
  ];
}
