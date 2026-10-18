import {
  CERTIFIED_EVIDENCE_COVERAGE,
  type CertifiedEvidenceCoverage,
  hasCertifiedEvidenceCoverage,
} from "../../shared/certifiedEvidenceCoverage.ts";
import {
  type ActiveRow,
  createReview,
  publicationErrorCode,
  sealCandidate,
} from "../../shared/forecast-publication/store.ts";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../shared/generated/certifiedEngineBuild.ts";

const MAX_ATTEMPTS = 5;
const RETRY_MS = 5 * 60_000;
const EVIDENCE_RETRY_MS = 6 * 60 * 60_000;
const LEASE_MS = 60_000;
// Incremental admission: never derive more than one candidate's profiles per run.
const BATCH_SIZE = 1;

export async function admitCandidates(
  db: D1Database,
  active: ActiveRow,
  now: number,
  coverage: readonly CertifiedEvidenceCoverage[] = CERTIFIED_EVIDENCE_COVERAGE,
) {
  // A crash during the final attempt is terminal too; it cannot pin the candidate page.
  await db
    .prepare(`UPDATE forecast_runtime_admissions SET state='dead',
    error_code=COALESCE(error_code,'publication_admission_exhausted'),
    lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE state='running' AND lease_until<=? AND attempts>=?`)
    .bind(now, now, MAX_ATTEMPTS)
    .run();
  const candidates = await db
    .prepare(`SELECT c.candidate_id,json_extract(c.payload_json,'$.certifiedSnapshot.cadence.version') AS cadence_version FROM forecast_candidates c
    LEFT JOIN forecast_runtime_admissions f ON f.candidate_id=c.candidate_id
    WHERE c.state IN ('crosschecked','x_unavailable','proposed')
      AND (f.candidate_id IS NULL OR f.state='ready' OR
        (f.attempts<? AND f.next_attempt_at<=? AND
          (f.state='pending' OR (f.state='running' AND f.lease_until<=?))))
      AND NOT EXISTS(SELECT 1 FROM forecast_runtime_approvals a WHERE a.candidate_id=c.candidate_id)
      AND NOT EXISTS(SELECT 1 FROM forecast_runtime_reviews r WHERE r.candidate_id=c.candidate_id
        AND r.environment=? AND r.action='approve' AND r.expected_sequence=? AND r.expires_at>?)
    ORDER BY CASE WHEN f.state IN ('pending','running') THEN 1 ELSE 0 END,
      c.created_at DESC,c.candidate_id LIMIT ?`)
    .bind(MAX_ATTEMPTS, now, now, active.environment, active.sequence, now, BATCH_SIZE)
    .all<{ candidate_id: string; cadence_version: string }>();
  for (const row of candidates.results) {
    const lease = crypto.randomUUID();
    const claimed = await db
      .prepare(`INSERT INTO forecast_runtime_admissions
      (candidate_id,state,attempts,next_attempt_at,lease_token,lease_until,updated_at)
      VALUES(?,'running',1,?,?,?,?)
      ON CONFLICT(candidate_id) DO UPDATE SET state='running',
        attempts=CASE WHEN state='ready' THEN 1 ELSE attempts+1 END,
        lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
      WHERE state='ready' OR (attempts<? AND next_attempt_at<=? AND
        (state='pending' OR (state='running' AND lease_until<=?)))
      RETURNING attempts`)
      .bind(row.candidate_id, now, lease, now + LEASE_MS, now, MAX_ATTEMPTS, now, now)
      .first<{ attempts: number }>();
    if (!claimed) continue;
    let state: "ready" | "pending" | "dead" = "ready";
    let code: string | null = null;
    try {
      if (
        row.cadence_version === "observed-median-v2" &&
        !hasCertifiedEvidenceCoverage(row.cadence_version, CERTIFIED_ENGINE_CODE_HASH, coverage)
      )
        throw new Error("awaiting_evidence_panel");
      const sealed = await sealCandidate(db, row.candidate_id, now);
      await createReview(db, active, "approve", row.candidate_id, sealed.hash, now);
    } catch (error) {
      code =
        error instanceof Error && error.message === "awaiting_evidence_panel"
          ? "awaiting_evidence_panel"
          : publicationErrorCode(error);
      state =
        code === "awaiting_evidence_panel" || claimed.attempts < MAX_ATTEMPTS ? "pending" : "dead";
    }
    const completed = await db
      .prepare(`UPDATE forecast_runtime_admissions SET state=?,error_code=COALESCE(?,error_code),
      attempts=attempts-?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE candidate_id=? AND state='running' AND lease_token=?`)
      .bind(
        state,
        code,
        Number(code === "awaiting_evidence_panel"),
        now + (code === "awaiting_evidence_panel" ? EVIDENCE_RETRY_MS : RETRY_MS),
        now,
        row.candidate_id,
        lease,
      )
      .run();
    if (completed.meta.changes !== 1) throw new Error("publication_admission_lease_lost");
    if (code)
      console.warn(
        JSON.stringify({
          event: "publication_candidate_review_failed",
          candidateId: row.candidate_id,
          code,
          state,
          attempts: claimed.attempts,
        }),
      );
  }
}
