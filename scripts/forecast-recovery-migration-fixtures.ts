import type { DatabaseSync } from "node:sqlite";

export const TARGET_ORIGIN = "00000000-0000-4000-8000-000000000001";
export const TARGET_RECOVERY = "00000000-0000-4000-8000-000000000002";
export const TARGET_CLAIM = "00000000-0000-4000-8000-000000000004";
const TARGET_HISTORY_TABLES = [
  "source_queue",
  "source_processing_claims",
  "source_processor_state",
  "source_processor_runs",
  "source_processor_item_bindings",
  "source_processor_incidents",
  "source_processor_incident_heads",
  "source_processor_detail_settlements",
];
export const EXCEPTION_ID = "00000000-0000-4000-8000-000000000007";
export const EXCEPTION_AT = "2026-10-01T00:00:00Z";
const EXCEPTION_PROOF = "00000000-0000-4000-8000-000000000006";

export function seedTargetHistory(db: DatabaseSync, environment: "staging" | "production") {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,review_generation,attempts,first_seen_at,updated_at)
    VALUES('naver-board-56','1800','https://game.naver.com/1800','Preserved current target','2026-10-01T00:00:00Z',1,'pending',4,2,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
    INSERT INTO source_processing_claims(source,item_id,claim_token,lease_until,source_generation,consecutive_failures)
    VALUES('naver-board-56','1800','${TARGET_CLAIM}','2026-10-01T01:00:00Z',4,1);
    INSERT INTO source_processor_state(singleton_id,epoch,state,failure_count,failed_scope,failed_source,failed_item_id,failed_generation,updated_at)
    VALUES(1,1,'held',3,'detail','naver-board-56','1800',1,'2026-10-01T00:00:00Z');`);
  const insertRun =
    db.prepare(`INSERT INTO source_processor_runs(token,epoch,kind,environment,status,started_at,lease_until,scope)
    VALUES(?,1,?, ?,?,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z','detail')`);
  insertRun.run(TARGET_ORIGIN, "normal", environment, "failure");
  insertRun.run(TARGET_RECOVERY, "recovery", environment, "running");
  db.prepare(`INSERT INTO source_processor_incidents(origin_run_token,epoch,scope,source,item_id,source_generation,item_claim_token,outcome,error_code,created_at)
    VALUES(?,1,'detail','naver-board-56','1800',1,'00000000-0000-4000-8000-000000000003','failure','source_processor_detail_unavailable','2026-10-01T00:00:00Z')`).run(
    TARGET_ORIGIN,
  );
  db.prepare("INSERT INTO source_processor_incident_heads(epoch,origin_run_token) VALUES(1,?)").run(
    TARGET_ORIGIN,
  );
  db.prepare(`INSERT INTO source_processor_item_bindings(run_token,source,item_id,item_claim_token,source_generation,settled,validated)
    VALUES(?,'naver-board-56','1800','00000000-0000-4000-8000-000000000003',1,1,0)`).run(
    TARGET_ORIGIN,
  );
  db.prepare(`INSERT INTO source_processor_detail_settlements(run_token,source,item_id,source_generation,item_claim_token,result_token,outcome,validated,metadata_json,created_at)
    VALUES(?,'naver-board-56','1800',1,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005','retry',0,'{"generation":1}','2026-10-01T00:00:00Z')`).run(
    TARGET_ORIGIN,
  );
}

export function insertTargetReservation(db: DatabaseSync) {
  db.prepare(`INSERT INTO source_processor_target_reservations VALUES(
    ?,'target-request',?,'naver-board-56','1800',4,?,'{"generation":4}',?,?,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z')`).run(
    TARGET_RECOVERY,
    TARGET_ORIGIN,
    TARGET_CLAIM,
    "b".repeat(64),
    "d".repeat(64),
  );
}

export function targetEvidenceHistory(db: DatabaseSync) {
  return TARGET_HISTORY_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}

export function seedExceptionHistory(db: DatabaseSync, environment: "staging" | "production") {
  seedTargetHistory(db, environment);
  insertTargetReservation(db);
  db.prepare(`INSERT INTO source_processor_recovery_probes(proof_id,recovery_run_token,request_id,payload_hash,origin_run_token,source,item_id,source_generation,item_claim_token,metadata_json,failed_error_code,response_hash,request_profile_hash,comparable,proof_impossible_reason,created_at)
    VALUES(?,?,'exception-probe',?,?,'naver-board-56','1800',4,?,'{"generation":4}','source_processor_detail_unavailable',?,?,0,'legacy evidence unavailable',?)`).run(
    EXCEPTION_PROOF,
    TARGET_RECOVERY,
    "a".repeat(64),
    TARGET_ORIGIN,
    TARGET_CLAIM,
    "b".repeat(64),
    "c".repeat(64),
    EXCEPTION_AT,
  );
  db.prepare(`INSERT INTO source_processor_item_exceptions(exception_id,proof_id,recovery_run_token,request_id,payload_hash,source,item_id,source_generation,review_generation,review_id,metadata_json,item_claim_token,mode,reason,force_confirmed,created_at)
    VALUES(?, ?,?,'exception-request',?,'naver-board-56','1800',4,4,'retained-review','{"generation":4}',?,'force','Retained historical operator exception',1,?)`).run(
    EXCEPTION_ID,
    EXCEPTION_PROOF,
    TARGET_RECOVERY,
    "d".repeat(64),
    TARGET_CLAIM,
    EXCEPTION_AT,
  );
}

export function insertExceptionAudit(db: DatabaseSync) {
  db.prepare(
    "INSERT INTO source_processor_exception_audits(exception_id,request_json,created_at) VALUES(?,?,?)",
  ).run(
    EXCEPTION_ID,
    JSON.stringify({
      requestId: "exception-request",
      proofId: EXCEPTION_PROOF,
      mode: "force",
      reason: "Operator reviewed unrecoverable evidence",
      selfDeclaredActor: "migration-test-operator",
      authenticatedCredentialType: "shared_admin_token",
      actorIdentityVerified: false,
    }),
    EXCEPTION_AT,
  );
}

export function exceptionEvidenceHistory(db: DatabaseSync) {
  return [
    ...TARGET_HISTORY_TABLES,
    "source_processor_target_reservations",
    "source_processor_recovery_receipts",
    "source_processor_control_reservations",
    "source_processor_control_results",
    "source_processor_recovery_probes",
    "source_processor_item_exceptions",
    "source_processor_exception_resolutions",
    "source_processor_proof_invalidations",
  ].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}
