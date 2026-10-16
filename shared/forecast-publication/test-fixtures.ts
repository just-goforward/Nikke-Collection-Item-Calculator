import legacySchema from "../../forecast-collector/fixtures/schema-v10.sql?raw";
import migration02 from "../../forecast-collector/migrations/0002_collector_deployment_sha.sql?raw";
import migration03 from "../../forecast-collector/migrations/0003_lightweight_source_queue.sql?raw";
import migration04 from "../../forecast-collector/migrations/0004_discord_approval_tests.sql?raw";
import migration05 from "../../forecast-collector/migrations/0005_discord_staging_adoptions.sql?raw";
import migration06 from "../../forecast-collector/migrations/0006_discord_staging_message_identity.sql?raw";
import migration07 from "../../forecast-collector/migrations/0007_workflow_dispatch_ops.sql?raw";
import migration08 from "../../forecast-collector/migrations/0008_manual_reviews_interactions_canary.sql?raw";
import migration09 from "../../forecast-collector/migrations/0009_d1_budget_canary_v6.sql?raw";
import migration10 from "../../forecast-collector/migrations/0010_canary_v10_version_identity.sql?raw";
import migration11 from "../../forecast-collector/migrations/0011_source_processing_and_refresh.sql?raw";
import migration12 from "../../forecast-collector/migrations/0012_staging_adoption_attempt_leases.sql?raw";
import migration13 from "../../forecast-collector/migrations/0013_source_metadata_and_adoption_infrastructure.sql?raw";
import migration14 from "../../forecast-collector/migrations/0014_source_processor_failure_budget.sql?raw";
import migration15 from "../../forecast-collector/migrations/0015_staging_adoption_recovery_clock.sql?raw";
import migration16 from "../../forecast-collector/migrations/0016_dispatcher_retry_budget.sql?raw";
import migration17 from "../../forecast-collector/migrations/0017_source_processor_incident_evidence.sql?raw";
import migration18 from "../../forecast-collector/migrations/0018_source_processor_target_reservations.sql?raw";
import migration19 from "../../forecast-collector/migrations/0019_source_processor_exception_audits.sql?raw";
import migration20 from "../../forecast-collector/migrations/0020_source_poll_recovery_audits.sql?raw";
import migration21 from "../../forecast-collector/migrations/0021_source_poll_marker_recovery_audits.sql?raw";
import migration22 from "../../forecast-collector/migrations/0022_forecast_runtime_versions.sql?raw";
import migration23 from "../../forecast-collector/migrations/0023_forecast_runtime_publication.sql?raw";
import { assertCertifiedRuntimeSupplySnapshot } from "../certifiedSupply.ts";
import { canonicalPublicationJson, publicationHash } from "../forecastPublication.ts";
import { buildV3SupplyForecastCandidate } from "../supplyForecastCandidate.ts";
import registry from "../supplyForecasts.json";
import { executeTestSql } from "../testD1Sql.ts";
import {
  createReview,
  initializePublication,
  type PublicationDatabase,
  readActive,
  sealCandidate,
} from "./store.ts";

const migrations = [
  migration02,
  migration03,
  migration04,
  migration05,
  migration06,
  migration07,
  migration08,
  migration09,
  migration10,
  migration11,
  migration12,
  migration13,
  migration14,
  migration15,
  migration16,
  migration17,
  migration18,
  migration19,
  migration20,
  migration21,
  migration22,
  migration23,
];
export const TEST_NOW = Date.parse("2026-10-07T03:00:00.000Z");

// Consumer tests start from the collector's committed renewal state. They test
// delivery/binding, not a duplicate implementation of the renewal operation.
export async function seedRenewedManualReview(db: PublicationDatabase) {
  const { reviewId, alertKey } = await seedManualReview(db, true);
  const newReviewId = `mr-${"b".repeat(32)}`;
  const now = new Date(TEST_NOW).toISOString();
  await db.batch([
    db
      .prepare("UPDATE source_manual_reviews SET state='expired',resolved_at=? WHERE review_id=?")
      .bind(now, reviewId),
    db.prepare(
      "UPDATE source_queue SET review_generation=1 WHERE source='naver-board-56' AND item_id='200'",
    ),
    db
      .prepare(`INSERT INTO source_manual_reviews
      (review_id,source,item_id,generation,state,created_at,expires_at)
      VALUES(?,'naver-board-56','200',1,'pending',?,?)`)
      .bind(newReviewId, now, new Date(TEST_NOW + 14 * 24 * 60 * 60_000).toISOString()),
    db
      .prepare(`UPDATE forecast_ops_alerts SET state='resolved',resolved_at=?,
      discord_message_id=NULL,last_sent_at=NULL,last_sent_occurrence_count=0,
      next_send_at=NULL,recovery_sent_at=NULL,last_send_error=NULL WHERE alert_key=?`)
      .bind(now, alertKey),
  ]);
  return { reviewId, newReviewId, alertKey };
}

export async function seedManualReview(
  db: PublicationDatabase,
  delivered = false,
  environment = "staging",
) {
  const reviewId = `mr-${"a".repeat(32)}`;
  const alertKey = `manual-review:${environment}:naver-board-56:200`;
  const now = new Date(TEST_NOW).toISOString();
  await db
    .prepare(`INSERT INTO source_queue
    (source,item_id,url,title,published_at,official,status,first_seen_at,updated_at)
    VALUES('naver-board-56','200','https://game.naver.com/lounge/nikke/board/detail/200',
    'Manual fixture',?,1,'manual_review',?,?)`)
    .bind(now, now, now)
    .run();
  await db
    .prepare(`INSERT INTO source_manual_reviews
    (review_id,source,item_id,generation,state,created_at,expires_at)
    VALUES(?,'naver-board-56','200',0,'pending',?,?)`)
    .bind(reviewId, now, new Date(TEST_NOW + 14 * 24 * 60 * 60_000).toISOString())
    .run();
  await db
    .prepare(`INSERT INTO forecast_ops_alerts
    (alert_key,environment,severity,component,error_code,state,context_json,
    first_seen_at,last_seen_at,last_sent_at,last_sent_occurrence_count,discord_message_id)
    VALUES(?,?,'warning','source-queue','source_item_manual_review','open',?,?,?,?,?,?)`)
    .bind(
      alertKey,
      environment,
      JSON.stringify({
        reviewId,
        title: "Manual fixture",
        url: "https://game.naver.com/lounge/nikke/board/detail/200",
      }),
      now,
      now,
      delivered ? now : null,
      delivered ? 1 : 0,
      delivered ? "666666666" : null,
    )
    .run();
  return { reviewId, alertKey };
}

/** Same retained v1 definitions and incremental migration path as the root migration suite.
 * There is no 0001 file: v1 is the original baseline, then files 0002..0023.
 */
export async function migratePublicationDb<Database extends PublicationDatabase>(
  db: Database,
  applyD1Migrations: Parameters<typeof executeTestSql<Database>>[2],
) {
  const tables = ["source_items", "schedule_events", "forecast_candidates", "candidate_sources"]
    .map((table) => {
      const definition = legacySchema.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\r?\\n\\);`),
      )?.[0];
      if (!definition) throw new Error(`legacy_fixture_missing:${table}`);
      return definition;
    })
    .join("\n");
  await executeTestSql(
    db,
    `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1,CURRENT_TIMESTAMP);
    CREATE TABLE collector_runs(id INTEGER PRIMARY KEY);${tables}`,
    applyD1Migrations,
  );
  for (const sql of migrations) await executeTestSql(db, sql, applyD1Migrations);
}

export async function seedCandidate(db: PublicationDatabase, revision = 1) {
  const entry = registry.forecasts.find((item) => item.id === registry.approvedForecastId);
  if (!entry) throw new Error("approved_fixture_missing");
  const snapshot = assertCertifiedRuntimeSupplySnapshot(Reflect.get(entry, "certifiedSnapshot"));
  const periods = snapshot.soloRounds
    .filter((round) => round.startGameDate > snapshot.coverage.currentDay && round.endGameDate)
    .slice(0, 3)
    .map((round) => ({
      effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
      effectiveUntil: `${round.endGameDate}T05:00:00+09:00`,
      scheduleStatus: "estimated" as const,
    }));
  const primary = periods[0]!;
  const candidate = buildV3SupplyForecastCandidate({
    candidateId: `forecast-publication-fixture-${revision}`,
    forecastId: entry.id,
    generatedAt: snapshot.asOf,
    sourceStatus: "x_unavailable",
    dispatchPolicyId: "dispatch-policy-v1",
    schedule: {
      status: "estimated",
      cadenceDays: null,
      soloStart: primary.effectiveFrom,
      soloEnd: primary.effectiveUntil,
      soloPeriods: periods,
      collaborationPeriods: [],
    },
    sourceEvidence: entry.sourceEvidence,
    warnings: [],
    certifiedSnapshot: snapshot,
  });
  const hash = await publicationHash(candidate);
  await db
    .prepare(`INSERT OR IGNORE INTO source_items VALUES('naver-board-56','100',
    'https://game.naver.com/lounge/nikke/board/detail/100','fixture','fixture',?,?,1,1,?,?)`)
    .bind(snapshot.asOf, "a".repeat(64), snapshot.asOf, snapshot.asOf)
    .run();
  await db
    .prepare(`INSERT OR IGNORE INTO schedule_events VALUES('event-1','solo','naver-board-56','100',
    ?,?,'confirmed',0,NULL,?)`)
    .bind(primary.effectiveFrom, primary.effectiveUntil, snapshot.asOf)
    .run();
  await db
    .prepare(`INSERT INTO forecast_candidates
    (candidate_id,forecast_id,schedule_event_id,game_day,revision,source_status,state,payload_json,payload_hash,created_at,updated_at)
    VALUES(?,?,'event-1','2026-10-07',?,'x_unavailable','x_unavailable',?,?,?,?)`)
    .bind(
      candidate.candidateId,
      candidate.forecastId,
      revision,
      canonicalPublicationJson(candidate),
      hash,
      snapshot.asOf,
      snapshot.asOf,
    )
    .run();
  return { candidate, hash };
}

export async function approvalReview(db: PublicationDatabase, revision = 1) {
  const { candidate, hash } = await seedCandidate(db, revision);
  const active = await initializePublication(db, "staging");
  await sealCandidate(db, candidate.candidateId, TEST_NOW);
  const reviewId = await createReview(db, active, "approve", candidate.candidateId, hash, TEST_NOW);
  await deliveredReview(db, reviewId);
  return { candidate, hash, reviewId };
}

async function deliveredReview(db: PublicationDatabase, reviewId: string) {
  await db
    .prepare(`UPDATE forecast_runtime_outbox SET state='sent',message_id='666666666',channel_id='333333333'
    WHERE review_id=? AND kind='review'`)
    .bind(reviewId)
    .run();
}

export async function emergencyReview(
  db: PublicationDatabase,
  action: "off" | "rollback",
  candidateId: string | null = null,
) {
  const active = await readActive(db, "staging");
  const version = candidateId
    ? await db
        .prepare("SELECT payload_hash FROM forecast_runtime_versions WHERE candidate_id=?")
        .bind(candidateId)
        .first<{ payload_hash: string }>()
    : null;
  const id = await createReview(
    db,
    active,
    action,
    candidateId,
    version?.payload_hash ?? null,
    TEST_NOW,
  );
  await deliveredReview(db, id);
  return id;
}
