import { DEDUPE_TTL_MS, MAX_STATE_BYTES, MAX_BATCH_STATEMENTS, parseDecisionEnvelope, STAGES } from "../../shared/decisionAnalyticsV3.ts";
import type { AnalyticsStore, MaintenanceHealth } from "./decision-analytics-handler.ts";
import { dayExpiry, utcDay, type CommitPlan, type Episode } from "./decision-analytics-model.ts";

export type Statement = {
  bind(...args: unknown[]): Statement;
  first<T>(): Promise<T | null>;
};
export type AnalyticsDatabase = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<Array<{ results?: Array<Record<string, unknown>> }>>;
};
// Conservative whole-second upper bound: expiry can reject up to1s early, never extend it.
// SQL source is unexecuted here; actual D1 function/batch/constraint verification is an apply gate.
const DB_NOW = "(CAST(strftime('%s','now') AS INTEGER)*1000+1000)";
const TABLES = ["decision_analytics_episodes", "decision_analytics_dedupe", "decision_analytics_daily", "decision_analytics_budget"] as const;
export const CLEANUP_ROWS_PER_TABLE = 100;
export const HEALTH_ROWS_PER_TABLE = 101;

export class D1DecisionAnalyticsStore implements AnalyticsStore {
  db: AnalyticsDatabase;
  constructor(db: AnalyticsDatabase) { this.db = db; }
  async deduped(id: string, now: number): Promise<boolean> {
    return Boolean(await this.db.prepare(
      "SELECT 1 AS found FROM decision_analytics_dedupe WHERE event_id=? AND expires_at>?",
    ).bind(id, now).first());
  }
  async episode(id: string, now: number): Promise<Episode | null> {
    const row = await this.db.prepare(
      `SELECT created_at,expires_at,revision,producer_version,producer_code_hash,
       CASE WHEN expires_at>? THEN state_json ELSE NULL END AS state_json
       FROM decision_analytics_episodes WHERE decision_id=?`,
    ).bind(now, id).first<{ created_at: number; expires_at: number; revision: number; producer_version: string; producer_code_hash: string; state_json: string | null }>();
    if (!row) return null;
    if (!Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
        row.expires_at !== row.created_at + 86_400_000 ||
        !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > STAGES.length)
      throw new Error("analytics_state_invalid");
    const metadata = { decisionId: id, createdAt: row.created_at, expiresAt: row.expires_at, revision: row.revision,
      producer: { producerVersion: row.producer_version, producerCodeHash: row.producer_code_hash } };
    if (row.expires_at <= now) return { ...metadata, slots: {} };
    if (!row.state_json || new TextEncoder().encode(row.state_json).byteLength > MAX_STATE_BYTES)
      throw new Error("analytics_state_invalid");
    const state = JSON.parse(row.state_json) as Episode;
    if (!state || Object.keys(state).sort().join(",") !== "createdAt,decisionId,expiresAt,producer,revision,slots" ||
        state.decisionId !== id || state.createdAt !== row.created_at || state.expiresAt !== row.expires_at ||
        state.revision !== row.revision || !state.slots || !state.slots.calculation ||
        Object.keys(state.slots).length !== row.revision) throw new Error("analytics_state_invalid");
    const calculation = state.slots.calculation;
    if (calculation.stage !== "calculation" || !state.producer ||
        Object.keys(state.producer).sort().join(",") !== "producerCodeHash,producerVersion" ||
        state.producer.producerVersion !== row.producer_version || state.producer.producerCodeHash !== row.producer_code_hash ||
        calculation.data.producerVersion !== row.producer_version || calculation.data.producerCodeHash !== row.producer_code_hash)
      throw new Error("analytics_producer_invalid");
    const ordinals = new Set<number>();
    const eventIds = new Set<string>();
    for (const [stage, slot] of Object.entries(state.slots)) {
      const { event } = parseDecisionEnvelope({ ...slot, turnstileToken: "transport-not-persisted" });
      if (event.stage !== stage || event.decisionId !== id || ordinals.has(event.ordinal) || eventIds.has(event.eventId))
        throw new Error("analytics_state_invalid");
      ordinals.add(event.ordinal); eventIds.add(event.eventId);
    }
    return state;
  }
  async reserveBudget(now: number, limit: number): Promise<boolean> {
    const day = utcDay(now);
    const row = await this.db.prepare(
      `INSERT INTO decision_analytics_budget(day,attempts,expires_at) VALUES(?,1,?)
       ON CONFLICT(day) DO UPDATE SET attempts=attempts+1
       WHERE attempts<? AND expires_at>? RETURNING attempts`,
    ).bind(day, dayExpiry(day), limit, now).first();
    return Boolean(row);
  }
  async health(now: number): Promise<MaintenanceHealth> {
    // Eight indexed scalar subqueries, each at most101 rows; no IDs or raw state returned.
    const fields = TABLES.flatMap((table, i) => [
      `(SELECT expires_at FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT 1) AS oldest${i}`,
      `(SELECT count(*) FROM (SELECT expires_at FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT ${HEALTH_ROWS_PER_TABLE})) AS count${i}`,
    ]);
    const row = await this.db.prepare(
      `SELECT last_success_ms,${fields.join(",")} FROM decision_analytics_maintenance WHERE singleton=1`,
    ).bind(...TABLES.flatMap(() => [now, now])).first<Record<string, number | null>>();
    if (!row) return { lastSuccess: null, oldestOverdue: null, backlog: 0, capped: false };
    const old = TABLES.map((_, i) => row[`oldest${i}`]).filter((n): n is number => n !== null && n !== undefined);
    const counts = TABLES.map((_, i) => Number(row[`count${i}`]));
    if (counts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > HEALTH_ROWS_PER_TABLE))
      throw new Error("analytics_health_invalid");
    return { lastSuccess: row["last_success_ms"] ?? null, oldestOverdue: old.length ? Math.min(...old) : null,
      backlog: counts.reduce((a, b) => a + b, 0), capped: counts.some((n) => n === HEALTH_ROWS_PER_TABLE) };
  }
  async commit(plan: CommitPlan, nonce: string): Promise<boolean> {
    const { episode, event } = plan;
    const winner = `EXISTS(SELECT 1 FROM decision_analytics_episodes WHERE decision_id=? AND write_nonce=? AND expires_at>${DB_NOW})`;
    const statements: Statement[] = [this.db.prepare(
      `INSERT INTO decision_analytics_episodes(decision_id,created_at,expires_at,revision,producer_version,producer_code_hash,state_json,write_nonce)
       SELECT ?,?,?,?,?,?,?,? WHERE ?>${DB_NOW}
       AND NOT EXISTS(SELECT 1 FROM decision_analytics_dedupe WHERE event_id=?)
       ON CONFLICT(decision_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json,write_nonce=excluded.write_nonce
       WHERE decision_analytics_episodes.revision=? AND decision_analytics_episodes.created_at=?
       AND decision_analytics_episodes.producer_version=? AND decision_analytics_episodes.producer_code_hash=?
       AND decision_analytics_episodes.expires_at>${DB_NOW}`,
    ).bind(episode.decisionId, episode.createdAt, episode.expiresAt, episode.revision,
      episode.producer.producerVersion, episode.producer.producerCodeHash, JSON.stringify(episode), nonce,
      episode.expiresAt, event.eventId, plan.previousRevision, episode.createdAt,
      episode.producer.producerVersion, episode.producer.producerCodeHash)];
    for (const increment of plan.increments) {
      statements.push(this.db.prepare(
        `INSERT INTO decision_analytics_daily(day,producer_version,producer_code_hash,metric,bucket,count,expires_at)
         SELECT ?,?,?,?,?,1,? WHERE ${winner}
         ON CONFLICT(day,producer_version,producer_code_hash,metric,bucket) DO UPDATE SET count=count+1
         WHERE decision_analytics_daily.expires_at>${DB_NOW}`,
      ).bind(plan.day, episode.producer.producerVersion, episode.producer.producerCodeHash,
        increment.metric, increment.bucket, plan.aggregateExpiry, episode.decisionId, nonce));
    }
    // Last mutation is both unique-event claim and an expiry fence. A winner expiring
    // mid-batch inserts NULL into explicit NOT NULL PK, aborting the same batch.
    statements.push(this.db.prepare(
      `INSERT INTO decision_analytics_dedupe(event_id,first_received_at,expires_at)
       SELECT CASE WHEN expires_at>${DB_NOW} THEN ? ELSE NULL END,?,?
       FROM decision_analytics_episodes WHERE decision_id=? AND write_nonce=?`,
    ).bind(event.eventId, plan.now, plan.now + DEDUPE_TTL_MS, episode.decisionId, nonce));
    statements.push(this.db.prepare(
      `SELECT 1 AS winner FROM decision_analytics_episodes WHERE decision_id=? AND write_nonce=? AND expires_at>${DB_NOW}`,
    ).bind(episode.decisionId, nonce));
    if (statements.length > MAX_BATCH_STATEMENTS) throw new Error("analytics_batch_bound");
    const results = await this.db.batch(statements);
    return results.at(-1)?.results?.[0]?.["winner"] === 1;
  }
  async cleanup(now: number, rowsPerTable = CLEANUP_ROWS_PER_TABLE): Promise<void> {
    if (!Number.isSafeInteger(rowsPerTable) || rowsPerTable < 1 || rowsPerTable > CLEANUP_ROWS_PER_TABLE)
      throw new Error("analytics_cleanup_budget_invalid");
    const keys = ["decision_id", "event_id", "day,producer_version,producer_code_hash,metric,bucket", "day"];
    const statements = TABLES.map((table, i) => this.db.prepare(
      `DELETE FROM ${table} WHERE (${keys[i]}) IN
       (SELECT ${keys[i]} FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT ${rowsPerTable})`,
    ).bind(now));
    statements.push(this.db.prepare(
      `INSERT INTO decision_analytics_maintenance(singleton,last_success_ms) VALUES(1,?)
       ON CONFLICT(singleton) DO UPDATE SET last_success_ms=excluded.last_success_ms`,
    ).bind(now));
    // Exactly one five-statement batch; no request-path purge/catch-up loop.
    await this.db.batch(statements);
  }
}
