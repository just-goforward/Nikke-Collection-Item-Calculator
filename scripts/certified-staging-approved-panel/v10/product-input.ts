/** Product imports are restricted to input preparation, never the oracle. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildConstructedForecastCandidate } from "../../../forecast-collector/src/constructed-candidate.ts";
import type { ScheduleEvent } from "../../../forecast-collector/src/types.ts";
import { SOLO_RAID_ROUND_HISTORY } from "../../../shared/soloRaidCadence.ts";
import { AS_OF, grants, history, seasons } from "./fixtures/input.ts";

export async function productInput() {
  const confirmedRounds = history.map(([round, startGameDate, status, sourceFeedId]) => ({
    round,
    startGameDate,
    status,
    sourceFeedId,
  }));
  assert.deepEqual(confirmedRounds.slice(0, 40), SOLO_RAID_ROUND_HISTORY);
  const events: ScheduleEvent[] = seasons.map(([round, startsAt, endsAt]) => {
    const text = `Season ${round}`;
    return {
      eventId: `v2:solo${round}`,
      eventType: "solo",
      startsAt,
      endsAt,
      scheduleStatus: "confirmed",
      manualReview: false,
      reason: null,
      segments: [
        { round, segment: 1, kind: "initial", effectiveFrom: startsAt, effectiveUntil: endsAt },
      ],
      sourceItem: {
        source: "naver-board-48",
        itemId: String(round),
        url: `https://game.naver.com/lounge/nikke/board/48/detail/${round}`,
        title: `solo${round}`,
        excerpt: text,
        normalizedText: text,
        publishedAt: startsAt,
        contentHash: createHash("sha256").update(text).digest("hex"),
        structured: true,
        official: true,
      },
    };
  });
  const anchor = events.at(-1);
  assert.ok(anchor);
  const constructed = await buildConstructedForecastCandidate(
    anchor.eventId,
    {
      event: anchor,
      soloEvents: events,
      evidenceEvents: events,
      scheduleStatus: "confirmed",
      cadenceDays: null,
    },
    events,
    { status: "x_unavailable", sourceItem: null, reason: null },
    Date.parse(AS_OF),
    1,
    grants,
    { cadenceVersion: "observed-median-v2", confirmedRounds },
  );
  const snapshot = constructed.envelope.candidate.certifiedSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.asOf, AS_OF);
  assert.equal(snapshot.cadence.version, "observed-median-v2");
  return snapshot;
}
