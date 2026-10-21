import {
  CERTIFIED_EVIDENCE_COVERAGE,
  type CertifiedEvidenceCoverage,
  hasCertifiedEvidenceCoverage,
} from "../../shared/certifiedEvidenceCoverage.ts";
import {
  errorCode,
  type PersistedErrorCode,
  persistedErrorCode,
  type SafeErrorCode,
} from "../../shared/errorCodes.ts";
import {
  type ActiveRow,
  createReview,
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
    .prepare(`SELECT c.candidate_id,c.created_at,json_extract(c.payload_json,'$.certifiedSnapshot.cadence.version') AS cadence_version FROM forecast_candidates c
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
    .all<{ candidate_id: string; created_at: string; cadence_version: string }>();
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
    let code: PersistedErrorCode | null = null;
    let diagnostic: SafeErrorCode | null = null;
    try {
      if (row.cadence_version !== "observed-median-v2") throw new Error("unsupported_cadence");
      if (!hasCertifiedEvidenceCoverage(row.cadence_version, CERTIFIED_ENGINE_CODE_HASH, coverage))
        throw new Error("awaiting_evidence_panel");
      // Only the newest admissible candidate per expected sequence asks for approval. An
      // older one is superseded instead of being renewed after its review expired: two
      // approval requests for the same sequence could only conflict at activation time.
      if (await supersededByNewerCandidate(db, row, active, now))
        throw new Error("publication_review_superseded");
      const sealed = await sealCandidate(db, row.candidate_id, now);
      await createReview(db, active, "approve", row.candidate_id, sealed.hash, now);
    } catch (error) {
      // `awaiting_evidence_panel` and `unsupported_cadence` are registered, so they
      // survive the sanitizer; every other failure is a registered code or the fixed
      // publication fallback in the column, never a driver message or a runtime error
      // name. The log keeps the diagnostic output, which may be a fixed runtime name.
      code = persistedErrorCode(error, "publication");
      diagnostic = errorCode(error, "publication");
      state =
        code === "unsupported_cadence" || code === "publication_review_superseded"
          ? "dead"
          : code === "awaiting_evidence_panel" || claimed.attempts < MAX_ATTEMPTS
            ? "pending"
            : "dead";
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
          errorCode: diagnostic,
          state,
          attempts: claimed.attempts,
        }),
      );
  }
}

/**
 * True when a newer admissible candidate for the same environment already holds a live
 * approve review for this expected sequence.
 *
 * A live review or the active candidate prevents a downgrade. Merely sealed or queued
 * candidates do not block recovery past a candidate that never becomes approvable.
 *
 * "Newer" compares `created_at` as the TEXT it is stored as, exactly like the page's
 * `c.created_at DESC,c.candidate_id` order, so two runs cannot disagree about which
 * candidate is the newest. (Comparing that column to a number would compare a string to a
 * number, where SQLite's type precedence makes every row "newer".)
 */
async function supersededByNewerCandidate(
  db: D1Database,
  row: { candidate_id: string; created_at: string },
  active: ActiveRow,
  now: number,
) {
  const newer = await db
    .prepare(`SELECT c.candidate_id FROM forecast_candidates c
    WHERE (c.created_at>? OR (c.created_at=? AND c.candidate_id<?))
      AND (c.candidate_id=? OR
        (c.state IN ('crosschecked','x_unavailable','proposed')
        AND NOT EXISTS(SELECT 1 FROM forecast_runtime_approvals a WHERE a.candidate_id=c.candidate_id)
        AND EXISTS(SELECT 1 FROM forecast_runtime_reviews r WHERE r.candidate_id=c.candidate_id
          AND r.environment=? AND r.action='approve' AND r.expected_sequence=? AND r.expires_at>?)))
    LIMIT 1`)
    .bind(
      row.created_at,
      row.created_at,
      row.candidate_id,
      active.candidate_id,
      active.environment,
      active.sequence,
      now,
    )
    .first<{ candidate_id: string }>();
  // Boolean, not `!== null`: D1's `first()` returns null for "no row", but a test adapter
  // may return undefined, and treating a missing row as found would supersede everything.
  return Boolean(newer);
}
