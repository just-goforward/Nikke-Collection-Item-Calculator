import { SOLO_RAID_ROUND_HISTORY } from "../../../../shared/soloRaidCadence";
import { extractNoticeText } from "../../solo-sections";
import { gameDay } from "./game-day";

export function soloRound(title: string, body: string, feedId: string): number | null {
  const text = `${title}\n${extractNoticeText(body).effective}`;
  const match = /솔로\s*레이드(?:\s*재오픈)?\s*시즌\s*(\d+)/.exec(text);
  if (match) return Number(match[1]);
  return (
    SOLO_RAID_ROUND_HISTORY.find((round) => round.sourceFeedId === Number(feedId))?.round ?? null
  );
}

/** Distinct playable windows remain distinct; reopening never replaces the initial segment. */
export function soloIdentity(
  round: number | null,
  feedId: string,
  startAt: string,
  existing: readonly { id: string; startAt: string; provenance: string | null }[],
): { eventId: string; round: number | null; segment: number } {
  if (round === null) return { eventId: `solo_${feedId}`, round, segment: 1 };
  const season = existing
    .map((event) => ({
      event,
      metadata: event.provenance
        ? (JSON.parse(event.provenance) as { round?: number; segment?: number })
        : {},
    }))
    .filter((entry) => entry.metadata.round === round);
  const same = season.find((entry) => gameDay(entry.event.startAt) === gameDay(startAt));
  if (same) return { eventId: same.event.id, round, segment: same.metadata.segment ?? 1 };
  const segment = Math.max(0, ...season.map((entry) => entry.metadata.segment ?? 1)) + 1;
  return { eventId: `solo_${round}_${segment}`, round, segment };
}
