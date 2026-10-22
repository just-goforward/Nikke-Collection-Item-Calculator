/** Product code prepares input only; independent calculation never imports this module. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildForecastCandidate } from "../../../forecast-collector/src/candidate.ts";
import type { ScheduleEvent } from "../../../forecast-collector/src/types.ts";
import { SOLO_RAID_ROUND_HISTORY } from "../../../shared/soloRaidCadence.ts";
import { AS_OF, grants, history, seasons } from "../v10/fixtures/input.ts";

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
  const { candidate } = await buildForecastCandidate(
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
    grants.map((grant) => ({
      ...grant,
      refs: grant.refs.map((ref) => ({ ...ref })),
      sourceIds: [...grant.sourceIds],
      restatementOf: [...grant.restatementOf],
    })),
    { version: "certified-daily-v5", cadenceVersion: "observed-median-v2", confirmedRounds },
  );
  const snapshot = candidate.certifiedSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.asOf, AS_OF);
  assert.equal(snapshot.version, "certified-daily-v5");
  assert.equal(candidate.rulesVersion, "schedule-kit-v5");
  assert.equal(candidate.payloadVersion, 6);
  return snapshot;
}
