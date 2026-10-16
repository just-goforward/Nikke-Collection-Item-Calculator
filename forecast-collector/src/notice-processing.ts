import { freezeJson } from "../../shared/certifiedSupplyModel";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import type { FetchLike } from "./naver";
import { parseScheduleEvents } from "./naver";
import { fetchNotice } from "./notice";
import type { ScheduleEvent, SourceQueueItem, SourceQueueResult } from "./types";

const constructedCandidates = new WeakSet<object>();
type ConstructedCandidate = NonNullable<Awaited<ReturnType<typeof buildNoticeCandidate>>>;

// This proof is an in-isolate object identity, never a serialized flag. Only
// the local v3 constructor can issue it, and the complete result is deep-frozen.
export function isConstructedNoticeCandidate(value: unknown): value is ConstructedCandidate {
  return typeof value === "object" && value !== null && constructedCandidates.has(value);
}

export async function processNotice(
  queued: SourceQueueItem,
  fetcher: FetchLike,
): Promise<SourceQueueResult> {
  const base = { source: queued.source, itemId: queued.itemId };
  if (!queued.official) return { ...base, outcome: "ignored", errorCode: "not_official_manager" };
  try {
    const item = await fetchNotice(
      queued.source === "naver-board-48" ? 48 : 56,
      queued.itemId,
      fetcher,
    );
    if (!item) return { ...base, outcome: "ignored", errorCode: "no_relevant_keyword" };
    if (item.url !== queued.url) throw new Error("naver_detail_url_mismatch");
    const event = (await parseScheduleEvents([item]))[0];
    if (!event) return { ...base, outcome: "ignored", errorCode: "no_schedule_event", item };
    return {
      ...base,
      outcome: event.manualReview ? "manual_review" : "processed",
      ...(event.reason ? { errorCode: event.reason } : {}),
      item,
      event,
    };
  } catch (error) {
    const errorCode = noticeErrorCode(error);
    const retry = /^(naver_timeout|naver_network|naver_http_429|naver_http_5\d\d)$/.test(errorCode);
    return { ...base, outcome: retry ? "retry" : "manual_review", errorCode };
  }
}

export async function buildNoticeCandidate(
  previous: readonly ScheduleEvent[],
  results: readonly SourceQueueResult[],
  nowMs: number,
  revision: number,
) {
  if (results.some((result) => result.outcome === "retry" || result.outcome === "manual_review"))
    return undefined;
  // A correction replaces every prior classification for that source, not just
  // a matching event ID (a solo notice can become a schedule-change notice).
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
  // Contradictory overlapping official intervals must not be silently deduplicated.
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
  const candidate = freezeJson({
    eventId:
      resolved.scheduleStatus === "estimated"
        ? (resolved.evidenceEvents.at(-1)?.eventId ?? resolved.event.eventId)
        : resolved.event.eventId,
    gameDay: envelope.candidate.forecastId.slice(7, 17),
    revision,
    envelope,
  });
  constructedCandidates.add(candidate);
  return candidate;
}

export function noticeErrorCode(error: unknown) {
  return (
    (error instanceof Error ? error.message : "unknown")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80) || "unknown"
  );
}
