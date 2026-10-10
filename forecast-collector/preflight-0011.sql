-- Read-only preflight. Stop migration 0011 if this returns any row.
-- Existing revisions require explicit human reconciliation; do not delete evidence.
SELECT game_day, revision, COUNT(*) AS duplicate_count,
       GROUP_CONCAT(candidate_id) AS candidate_ids
FROM forecast_candidates
GROUP BY game_day, revision
HAVING COUNT(*) > 1
ORDER BY game_day, revision;
