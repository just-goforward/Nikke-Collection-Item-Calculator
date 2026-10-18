import fc from "fast-check";
import { expect, it } from "vitest";
import { assertProperty } from "../../shared/propertyHarness";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import generatorSource from "./notice-overlap.property.test.ts?raw";
import { buildNoticeCandidate } from "./notice-processing";
import implementationSource from "./notice-processing.ts?raw";
import type { ScheduleEvent, SourceQueueResult } from "./types";

// Retained d336e9c constructor logic. Only the non-observable freeze/WeakSet
// bookkeeping is omitted; comparison includes complete serialized candidates.
async function oldBuild(
  previous: readonly ScheduleEvent[],
  results: readonly SourceQueueResult[],
  nowMs: number,
  revision: number,
) {
  if (results.some((result) => result.outcome === "retry" || result.outcome === "manual_review"))
    return undefined;
  const replaced = new Set(
    results
      .filter((result) => result.outcome !== "retry")
      .map((result) => `${result.source}:${result.itemId}`),
  );
  const events = [
    ...previous.filter(
      (event) => !replaced.has(`${event.sourceItem.source}:${event.sourceItem.itemId}`),
    ),
    ...results.flatMap((result) => (result.event ? [result.event] : [])),
  ];
  const latestSolo = events
    .filter((event) => event.eventType === "solo")
    .sort(
      (left, right) =>
        Date.parse(right.sourceItem.publishedAt) - Date.parse(left.sourceItem.publishedAt),
    )[0];
  if (
    events.some(
      (event) =>
        event.eventType === "schedule_change" &&
        event.manualReview &&
        (!latestSolo ||
          Date.parse(event.sourceItem.publishedAt) >=
            Date.parse(latestSolo.sourceItem.publishedAt)),
    )
  )
    return undefined;
  const solos = events.filter(
    (event) => event.eventType === "solo" && !event.manualReview && event.startsAt && event.endsAt,
  );
  if (
    solos.some((event, index) =>
      solos
        .slice(index + 1)
        .some(
          (other) =>
            event.startsAt !== null &&
            event.endsAt !== null &&
            other.startsAt !== null &&
            other.endsAt !== null &&
            Date.parse(event.startsAt) < Date.parse(other.endsAt) &&
            Date.parse(other.startsAt) < Date.parse(event.endsAt) &&
            (event.startsAt !== other.startsAt || event.endsAt !== other.endsAt),
        ),
    )
  ) {
    throw new Error("runtime_ingestion_source_conflict");
  }
  const resolved = resolveSoloSchedule(events, nowMs);
  if (!resolved) return undefined;
  const envelope = await buildForecastCandidate(
    resolved,
    events,
    { status: "x_unavailable", sourceItem: null, reason: "runtime_advisory_pending" },
    nowMs,
    revision,
  );
  return {
    eventId:
      resolved.scheduleStatus === "estimated"
        ? (resolved.evidenceEvents.at(-1)?.eventId ?? resolved.event.eventId)
        : resolved.event.eventId,
    gameDay: envelope.candidate.forecastId.slice(7, 17),
    revision,
    envelope,
  };
}

const now = Date.parse("2026-08-20T12:00:00Z");
const dates = [
  null,
  "",
  "invalid",
  "2026-08-20T00:00:00.000Z",
  "2026-08-21T00:00:00.000Z",
  "2026-08-22T00:00:00.000Z",
  "2026-08-21T09:00:00+09:00",
] as const;

function event(startsAt: string | null, endsAt: string | null, index: number): ScheduleEvent {
  return {
    eventId: `naver-board-56:${index}:solo`,
    eventType: "solo",
    startsAt,
    endsAt,
    scheduleStatus: "confirmed",
    manualReview: false,
    reason: null,
    sourceItem: {
      source: "naver-board-56",
      itemId: String(index),
      url: `https://game.naver.com/lounge/nikke/board/detail/${index}`,
      title: "솔로 레이드",
      excerpt: "솔로 레이드",
      normalizedText: "솔로 레이드",
      publishedAt: "2026-08-18T03:00:00.000Z",
      contentHash: "a".repeat(64),
      structured: true,
      official: true,
    },
  };
}

async function outcome(
  build: typeof oldBuild,
  events: ScheduleEvent[],
  results: SourceQueueResult[],
) {
  try {
    return { json: JSON.stringify(await build(events, results, now, 1)) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

it.each([
  ["duplicates", [event(dates[3], dates[4], 1), event(dates[3], dates[4], 1)]],
  ["touching", [event(dates[3], dates[4], 1), event(dates[4], dates[5], 2)]],
  ["invalid dates", [event("invalid", dates[5], 1), event(dates[3], "invalid", 2)]],
  ["overlapping", [event(dates[3], dates[5], 1), event(dates[4], dates[5], 2)]],
  ["equivalent timestamp spelling", [event(dates[3], dates[4], 1), event(dates[3], dates[6], 2)]],
] as const)("%s preserves the old overlap decision and output bytes", async (_name, events) => {
  expect(await outcome(buildNoticeCandidate, [...events], [])).toEqual(
    await outcome(oldBuild, [...events], []),
  );
});

it("ignores a stored cadence estimate overlapping a later confirmed interval", async () => {
  // Staging: estimated 9/21~9/27 (from 8060044) vs confirmed 8207413 9/24~9/30.
  const confirmed = event("2026-09-24T03:00:00.000Z", "2026-09-30T19:59:00.000Z", 1);
  const estimated = {
    ...event("2026-09-21T03:00:00.000Z", "2026-09-27T19:59:00.000Z", 2),
    scheduleStatus: "estimated" as const,
    reason: "recent_six_start_median",
  };
  const later = event("2026-10-15T03:00:00.000Z", "2026-10-21T19:59:00.000Z", 3);
  const conflicting = { ...estimated, scheduleStatus: "confirmed" as const, reason: null };
  expect(await outcome(buildNoticeCandidate, [confirmed, estimated, later], [])).not.toEqual({
    error: "runtime_ingestion_source_conflict",
  });
  expect(await outcome(buildNoticeCandidate, [confirmed, conflicting, later], [])).toEqual({
    error: "runtime_ingestion_source_conflict",
  });
});

it("matches the old pairwise algorithm for generated intervals, duplicates and replacements", async () => {
  await assertProperty(
    fc.asyncProperty(
      fc.array(
        fc.record({
          start: fc.constantFrom(...dates),
          end: fc.constantFrom(...dates),
          manual: fc.boolean(),
          kind: fc.constantFrom("solo" as const, "collaboration" as const),
          copies: fc.integer({ min: 1, max: 3 }),
        }),
        { maxLength: 6 },
      ),
      fc.boolean(),
      async (specs, replace) => {
        const events = specs.flatMap((spec, index) =>
          Array.from({ length: spec.copies }, () => ({
            ...event(spec.start, spec.end, index + 1),
            manualReview: spec.manual,
            eventType: spec.kind,
          })),
        );
        const results: SourceQueueResult[] =
          replace && events[0]
            ? [
                {
                  source: "naver-board-56",
                  itemId: events[0].sourceItem.itemId,
                  outcome: "processed",
                  event: { ...events[0], startsAt: dates[3], endsAt: dates[5] },
                },
              ]
            : [];
        expect(await outcome(buildNoticeCandidate, events, results)).toEqual(
          await outcome(oldBuild, events, results),
        );
      },
    ),
    {
      name: "notice-overlap.old-algorithm-equivalence",
      numRuns: 100,
      timeLimitMs: 15_000,
      identity: {
        file: "forecast-collector/src/notice-overlap.property.test.ts",
        generatorSource,
        sources: { "forecast-collector/src/notice-processing.ts": implementationSource },
      },
    },
  );
}, 25_000);
