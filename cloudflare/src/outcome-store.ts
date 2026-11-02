import {
  OUTCOME_ATTEMPT_PATCH_TTL_MS, OUTCOME_RECEIPT_TTL_MS,
  extractOutcomeRawFacts, OutcomeAnalyticsError, type OutcomeCommit, type OutcomeRawFacts,
} from "../../shared/decisionOutcomeV4.ts";
import { kstGameDateKeyFromUnixSeconds } from "./date-key.ts";
import type { MaintenanceHealth } from "./decision-analytics-handler.ts";
import { kitResultAggregateStatement, type KitAggregateInput } from "./kit-result-aggregate.ts";
import { outcomeArchiveStatements, type OutcomeDatabase, type PreparedOutcomePublication } from "./outcome-public-store.ts";
import type { ValidatedKitResultEvent } from "./event-validation-types.ts";

export type StoredOutcome = {
  initialCommitDigest: string; rawAdmitted: number; patchRevision: number;
  legacySettled: boolean; legacySettlementDigest: string | null; facts: OutcomeRawFacts;
};
export type OutcomeControl = {
  expires_at: number; legacy_attempt_count: number | null;
};
export const OUTCOME_CLEANUP_MAX_ROWS = 100;
const DB_NOW = "(CAST(strftime('%s','now') AS INTEGER)*1000+1000)";
const CONTROL_TABLES = ["outcome_controls", "outcome_receipts", "outcome_budget"] as const;
const SUMMARY_KEY = "producer_version,producer_code_hash,recommended_current,chosen_method,wait_recommended";

function legacyInput(event: ValidatedKitResultEvent, now: number): KitAggregateInput {
  return {
    grade: event.start.grade, level: event.start.level, expBucket: event.start.exp,
    dateKey: kstGameDateKeyFromUnixSeconds(Math.floor(now / 1000)), nowSeconds: Math.floor(now / 1000),
    kit: event.kit, recommendedUses: event.recommendedUses, outcome: event.outcome, successAttempt: event.successAttempt,
  };
}

export class D1OutcomeStore {
  readonly db: OutcomeDatabase;
  constructor(db: OutcomeDatabase) { this.db = db; }
  async lookup(reportId: string): Promise<StoredOutcome | null> {
    const row = await this.db.prepare(
      `SELECT e.initial_commit_digest,e.raw_admitted,e.patch_revision,e.legacy_settled,e.legacy_settlement_digest,
        r.attempt_count,r.outcome,f.*,s.content_hash,s.projection_policy,s.game_day,s.slot_start,s.slot_end
       FROM outcome_effects e JOIN outcome_facts f ON f.report_id=e.report_id
       JOIN outcome_results r ON r.report_id=e.report_id
       JOIN outcome_public_slots s ON s.slot_id=f.slot_id WHERE e.report_id=?`,
    ).bind(reportId).first<{
      initial_commit_digest: string; raw_admitted: number; patch_revision: number; legacy_settled: number;
      legacy_settlement_digest: string | null; attempt_count: number | null; outcome: OutcomeRawFacts["outcome"];
      producer_version: string; producer_code_hash: string; recommended_current: OutcomeRawFacts["recommendedCurrent"];
      chosen_method: OutcomeRawFacts["chosenMethod"]; recommended_uses: number; wait_recommended: number;
      holdings_blue: number; holdings_purple: number; holdings_yellow: number;
      content_hash: string; projection_policy: OutcomeRawFacts["supplyReference"]["projectionPolicyVersion"];
      game_day: string; slot_start: string; slot_end: string;
    }>();
    if (!row) return null;
    return {
      initialCommitDigest: row.initial_commit_digest, rawAdmitted: row.raw_admitted,
      patchRevision: row.patch_revision, legacySettled: row.legacy_settled === 1,
      legacySettlementDigest: row.legacy_settlement_digest,
      facts: {
        producerVersion: row.producer_version, producerCodeHash: row.producer_code_hash,
        supplyReference: { publicationContentHash: row.content_hash, projectionPolicyVersion: row.projection_policy,
          gameDay: row.game_day, slotStart: row.slot_start, slotEnd: row.slot_end },
        holdings: { blue: row.holdings_blue, purple: row.holdings_purple, yellow: row.holdings_yellow },
        recommendedCurrent: row.recommended_current, chosenMethod: row.chosen_method, recommendedUses: row.recommended_uses,
        waitRecommended: row.wait_recommended === 1, outcome: row.outcome, attemptCount: row.attempt_count,
      },
    };
  }
  async control(reportId: string): Promise<OutcomeControl | null> {
    return this.db.prepare(
      `SELECT expires_at,legacy_attempt_count FROM outcome_controls WHERE report_id=?`,
    ).bind(reportId).first<OutcomeControl>();
  }
  async reserveBudget(now: number, maximum: number): Promise<boolean> {
    const day = new Date(now).toISOString().slice(0, 10);
    return Boolean(await this.db.prepare(
      `INSERT INTO outcome_budget(day,attempts,expires_at) VALUES(?,1,?)
       ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<?
       RETURNING attempts`,
    ).bind(day, Date.parse(`${day}T00:00:00Z`) + OUTCOME_RECEIPT_TTL_MS, maximum).first());
  }
  async health(now: number): Promise<MaintenanceHealth> {
    const fields = CONTROL_TABLES.flatMap((table, index) => [
      `(SELECT expires_at FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT 1) oldest${index}`,
      `(SELECT COUNT(*) FROM (SELECT expires_at FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT 101)) count${index}`,
    ]);
    const row = await this.db.prepare(
      `SELECT last_success_ms,${fields.join(",")} FROM outcome_maintenance WHERE singleton=1`,
    ).bind(...CONTROL_TABLES.flatMap(() => [now, now])).first<Record<string, number | null>>();
    if (!row) return { lastSuccess: null, oldestOverdue: null, backlog: 0, capped: false };
    const counts = CONTROL_TABLES.map((_, index) => Number(row[`count${index}`]));
    const overdue = CONTROL_TABLES.map((_, index) => row[`oldest${index}`])
      .filter((value): value is number => value !== null && value !== undefined);
    return {
      lastSuccess: row["last_success_ms"] ?? null, oldestOverdue: overdue.length ? Math.min(...overdue) : null,
      backlog: counts.reduce((sum, value) => sum + value, 0), capped: counts.some(value => value >= 101),
    };
  }
  async commit(
    event: OutcomeCommit, initialDigest: string, publicCopy: PreparedOutcomePublication,
    now: number, nonce: string, settlement: ValidatedKitResultEvent | null, settlementDigest: string | null,
  ): Promise<boolean> {
    const id = event.reportId, data = extractOutcomeRawFacts(event);
    const legacy = settlement ? legacyInput(settlement, now) : null;
    const winner = `EXISTS(SELECT 1 FROM outcome_effects WHERE report_id=? AND initial_claim=? AND raw_admitted=0)`;
    const known = data.attemptCount !== null ? 1 : 0, great = data.outcome === "great" ? 1 : 0;
    const statements = [
      this.db.prepare(
        `INSERT INTO outcome_effects
         (report_id,initial_commit_digest,initial_claim,raw_admitted,attempt_applied,legacy_settled)
         VALUES(?,?,?,0,0,0) ON CONFLICT(report_id) DO NOTHING`,
      ).bind(id, initialDigest, nonce),
      // The old writer's existing unique receipt is reserved in this transaction
      // even for an unknown attempt. This also closes the old/new-writer race.
      this.db.prepare(
        `INSERT INTO event_ids(id,created_at) SELECT ?,? WHERE ${winner}`,
      ).bind(id, Math.floor(now / 1000), id, nonce),
      ...outcomeArchiveStatements(this.db, publicCopy, id, nonce),
      this.db.prepare(
        `INSERT INTO outcome_facts
         (report_id,slot_id,producer_version,producer_code_hash,holdings_blue,holdings_purple,holdings_yellow,
          recommended_current,chosen_method,recommended_uses,wait_recommended)
         SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM outcome_public_slots WHERE slot_id=? AND normalized_digest=?)
           THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,? WHERE ${winner}`,
      ).bind(id, publicCopy.slotId, publicCopy.normalizedDigest, publicCopy.slotId,
        data.producerVersion, data.producerCodeHash, data.holdings.blue, data.holdings.purple, data.holdings.yellow,
        data.recommendedCurrent, data.chosenMethod, data.recommendedUses, Number(data.waitRecommended), id, nonce),
      this.db.prepare(
        `INSERT INTO outcome_results(report_id,outcome,attempt_count) SELECT ?,?,? WHERE ${winner}`,
      ).bind(id, data.outcome, data.attemptCount, id, nonce),
      this.db.prepare(
        `INSERT INTO outcome_controls
         (report_id,received_ms,expires_at,legacy_attempt_count) SELECT ?,?,?,? WHERE ${winner}`,
      ).bind(id, now, now + OUTCOME_ATTEMPT_PATCH_TTL_MS,
        legacy ? legacy.outcome === "great_success" ? legacy.successAttempt : legacy.recommendedUses : null, id, nonce),
      this.db.prepare(
        `INSERT INTO outcome_receipts(report_id,received_ms,expires_at) SELECT ?,?,? WHERE ${winner}`,
      ).bind(id, now, now + OUTCOME_RECEIPT_TTL_MS, id, nonce),
      this.db.prepare(
        `INSERT INTO outcome_summary(${SUMMARY_KEY},reports,great_reports,no_great_reports,known_attempt_reports,attempts,known_great_reports)
         SELECT ?,?,?,?,?,1,?,?,?,?,? WHERE ${winner}
         ON CONFLICT(${SUMMARY_KEY}) DO UPDATE SET reports=reports+1,
           great_reports=great_reports+excluded.great_reports,no_great_reports=no_great_reports+excluded.no_great_reports,
           known_attempt_reports=known_attempt_reports+excluded.known_attempt_reports,
           attempts=attempts+excluded.attempts,known_great_reports=known_great_reports+excluded.known_great_reports`,
      ).bind(data.producerVersion, data.producerCodeHash, data.recommendedCurrent, data.chosenMethod,
        Number(data.waitRecommended), great, 1 - great, known, data.attemptCount ?? 0, great * known, id, nonce),
    ];
    if (legacy) statements.push(kitResultAggregateStatement(this.db, legacy, { reportId: id, nonce, phase: "initial" })!);
    statements.push(
      this.db.prepare(
        `UPDATE outcome_effects SET raw_admitted=CASE WHEN EXISTS(
           SELECT 1 FROM outcome_controls WHERE report_id=? AND expires_at>${DB_NOW}) THEN 1 ELSE NULL END,
           attempt_applied=?,legacy_settled=?,legacy_settlement_digest=?
         WHERE report_id=? AND initial_claim=? AND raw_admitted=0 RETURNING report_id`,
      ).bind(id, known, legacy ? 1 : 0, settlementDigest, id, nonce),
    );
    try {
      const results = await this.db.batch(statements);
      return results.at(-1)!.results.length === 1;
    } catch (error) {
      // Ambiguous acknowledgements are classified using durable state, never replayed.
      if (await this.lookup(id)) return false;
      if (await this.db.prepare("SELECT 1 found FROM event_ids WHERE id=?").bind(id).first())
        throw new OutcomeAnalyticsError(409, "report_id_conflict");
      throw error;
    }
  }
  async patch(
    reportId: string, attemptCount: number | null, previous: StoredOutcome,
    now: number, nonce: string, settlement: ValidatedKitResultEvent | null, settlementDigest: string | null,
  ): Promise<boolean> {
    const data = previous.facts;
    const applyAttempt = data.attemptCount === null && attemptCount !== null;
    const legacy = !previous.legacySettled && settlement ? legacyInput(settlement, now) : null;
    if (!applyAttempt && !legacy) return false;
    const winner = `EXISTS(SELECT 1 FROM outcome_effects WHERE report_id=? AND patch_claim=? AND patch_revision=?)`;
    const claim = [reportId, nonce, previous.patchRevision];
    const statements = [
      this.db.prepare(
        `UPDATE outcome_effects SET patch_claim=? WHERE report_id=? AND raw_admitted=1 AND patch_revision=?
         AND EXISTS(SELECT 1 FROM outcome_controls WHERE report_id=? AND expires_at>${DB_NOW})`,
      ).bind(nonce, reportId, previous.patchRevision, reportId),
    ];
    if (applyAttempt) statements.push(
      this.db.prepare(
        `UPDATE outcome_results SET attempt_count=? WHERE report_id=? AND attempt_count IS NULL AND ${winner}`,
      ).bind(attemptCount, reportId, ...claim),
      this.db.prepare(
        `UPDATE outcome_summary SET known_attempt_reports=known_attempt_reports+1,attempts=attempts+?,
         known_great_reports=known_great_reports+?
         WHERE producer_version=? AND producer_code_hash=? AND recommended_current=? AND chosen_method=?
         AND wait_recommended=? AND ${winner}`,
      ).bind(attemptCount, data.outcome === "great" ? 1 : 0, data.producerVersion, data.producerCodeHash,
        data.recommendedCurrent, data.chosenMethod, Number(data.waitRecommended), ...claim),
    );
    if (legacy) statements.push(
      kitResultAggregateStatement(this.db, legacy, { reportId, nonce, phase: "patch", revision: previous.patchRevision })!,
      this.db.prepare(`UPDATE outcome_controls SET legacy_attempt_count=? WHERE report_id=? AND ${winner}`)
        .bind(legacy.outcome === "great_success" ? legacy.successAttempt : legacy.recommendedUses, reportId, ...claim),
    );
    statements.push(this.db.prepare(
      `UPDATE outcome_effects SET patch_revision=CASE WHEN EXISTS(
        SELECT 1 FROM outcome_controls WHERE report_id=? AND expires_at>${DB_NOW}) THEN patch_revision+1 ELSE NULL END,
        attempt_applied=CASE WHEN ?=1 THEN 1 ELSE attempt_applied END,
        legacy_settled=CASE WHEN ?=1 THEN 1 ELSE legacy_settled END,
        legacy_settlement_digest=CASE WHEN ?=1 THEN ? ELSE legacy_settlement_digest END
       WHERE report_id=? AND patch_claim=? AND patch_revision=? RETURNING report_id`,
    ).bind(reportId, Number(applyAttempt), legacy ? 1 : 0, legacy ? 1 : 0, settlementDigest, ...claim));
    const results = await this.db.batch(statements);
    return results.at(-1)!.results.length === 1;
  }
  async cleanup(now: number, rows: number): Promise<void> {
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > OUTCOME_CLEANUP_MAX_ROWS)
      throw new Error("outcome_cleanup_budget_invalid");
    const statements = CONTROL_TABLES.map((table, index) => {
      const key = index === 2 ? "day" : "report_id";
      return this.db.prepare(
        `DELETE FROM ${table} WHERE ${key} IN(SELECT ${key} FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT ?)`,
      ).bind(now, rows);
    });
    statements.push(this.db.prepare("UPDATE outcome_maintenance SET last_success_ms=? WHERE singleton=1").bind(now));
    await this.db.batch(statements);
  }
}
