import { freezeJson } from "../../shared/certifiedSupplyModel";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import type { FetchLike } from "./naver";
import { parseScheduleEvents } from "./naver";
import { fetchNotice } from "./notice";
import type { ProfileCounts } from "./profile";
import { judgments, soloLookup } from "./solo-judgment";
import { readScheduleLedger } from "./source-queue";
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
  counts?: ProfileCounts,
  db?: D1Database,
): Promise<SourceQueueResult> {
  const base = { source: queued.source, itemId: queued.itemId };
  if (!queued.official) return { ...base, outcome: "ignored", errorCode: "not_official_manager" };
  try {
    const item = await fetchNotice(
      queued.source === "naver-board-48" ? 48 : 56,
      queued.itemId,
      fetcher,
      counts,
    );
    if (!item) return { ...base, outcome: "ignored", errorCode: "no_relevant_keyword" };
    if (item.url !== queued.url) throw new Error("naver_detail_url_mismatch");
    const lookup = soloLookup(item);
    const known = db && lookup.solo ? (await readScheduleLedger(db, Date.now())).events : [];
    const maintenance: { text: string; publishedAt: string }[] = [];
    if (db)
      for (const date of lookup.dates) {
        const stored = await db
          .prepare(`SELECT
        json_extract(item_json,'$.normalizedText') AS text,
        json_extract(item_json,'$.publishedAt') AS publishedAt
        FROM source_notice_revisions r WHERE source='naver-board-48'
        AND json_extract(item_json,'$.publishedAt')>=? AND json_extract(item_json,'$.publishedAt')<?
        AND EXISTS (SELECT 1 FROM json_each(?) needle WHERE instr(replace(replace(replace(json_extract(item_json,'$.normalizedText'),' ',''),':','-'),'：','-'),needle.value)>0)
        AND source_revision=(SELECT MAX(source_revision) FROM source_notice_revisions n WHERE n.source=r.source AND n.item_id=r.item_id)
        ORDER BY publishedAt DESC LIMIT 60`)
          .bind(
            `${date.slice(0, 4)}-01-01T00:00:00.000Z`,
            new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString(),
            JSON.stringify([
              ...new Set(
                [String(Number(date.slice(5, 7))), date.slice(5, 7)].flatMap((month) =>
                  [String(Number(date.slice(8, 10))), date.slice(8, 10)].map(
                    (day) => `점검일시-${month}월${day}일`,
                  ),
                ),
              ),
            ]),
          )
          .all<{ text: string; publishedAt: string }>();
        maintenance.push(...stored.results);
      }
    const events = await parseScheduleEvents([item], { known, maintenance });
    const event = events.find((entry) => entry.manualReview) ?? events[0];
    if (!event)
      return {
        ...base,
        outcome: "ignored",
        errorCode: judgments.get(item)?.every((judgment) => judgment.verdict === "no_change")
          ? "no_change"
          : "no_schedule_event",
        item,
      };
    return {
      ...base,
      outcome: event.manualReview ? "manual_review" : "processed",
      ...(event.reason ? { errorCode: event.reason } : {}),
      item,
      event,
      events: events.map((entry) => ({
        ...entry,
        manualReview: event.manualReview || entry.manualReview,
      })),
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
      .filter((result) => result.outcome !== "retry" && result.errorCode !== "no_change")
      .map((result) => `${result.source}:${result.itemId}`),
  );
  const events = [
    ...previous.filter(
      (event) => !replaced.has(`${event.sourceItem.source}:${event.sourceItem.itemId}`),
    ),
    ...results.flatMap(
      (result) =>
        result.events ??
        (result.item
          ? judgments.get(result.item)?.flatMap((entry) => (entry.event ? [entry.event] : []))
          : undefined) ??
        (result.event ? [result.event] : []),
    ),
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
  const solos = events
    .filter(
      (event) =>
        event.eventType === "solo" && !event.manualReview && event.startsAt && event.endsAt,
    )
    .map((event) => ({
      event,
      start: Date.parse(event.startsAt as string),
      end: Date.parse(event.endsAt as string),
    }));
  for (const [index, left] of solos.entries()) {
    for (let next = index + 1; next < solos.length; next++) {
      const right = solos[next];
      if (
        right &&
        left.start < right.end &&
        right.start < left.end &&
        (left.event.startsAt !== right.event.startsAt || left.event.endsAt !== right.event.endsAt)
      ) {
        throw new Error("runtime_ingestion_source_conflict");
      }
    }
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
