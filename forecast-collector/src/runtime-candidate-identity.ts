import { sha256Hex, stableJson } from "./crypto";
import type { buildNoticeCandidate } from "./notice-processing";

export async function candidateAlreadyStored(
  db: D1Database,
  candidate: NonNullable<Awaited<ReturnType<typeof buildNoticeCandidate>>>,
) {
  const existing = await db
    .prepare(
      "SELECT forecast_id,payload_json,payload_hash FROM forecast_candidates WHERE candidate_id=?",
    )
    .bind(candidate.envelope.candidate.candidateId)
    .first<{ forecast_id: string; payload_json: string; payload_hash: string }>();
  if (!existing) return false;
  const replay = {
    ...candidate.envelope.candidate,
    forecastId: existing.forecast_id,
    profiles: candidate.envelope.candidate.profiles.map((profile) => ({
      ...profile,
      id: `${existing.forecast_id}@${profile.effectiveFrom}`,
    })),
  };
  const replayJson = stableJson(replay);
  // The normal writer stores JSON.stringify(candidate). Exact byte equality
  // proves equality without parsing/re-canonicalizing a second large snapshot.
  // Retain canonical comparison for equivalent historical property orderings.
  if (
    (await sha256Hex(replayJson)) !== existing.payload_hash ||
    (JSON.stringify(replay) !== existing.payload_json &&
      stableJson(JSON.parse(existing.payload_json)) !== replayJson)
  )
    throw new Error("runtime_candidate_identity_conflict");
  return true;
}
