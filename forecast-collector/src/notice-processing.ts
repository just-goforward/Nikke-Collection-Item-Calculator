import { freezeJson } from "../../shared/certifiedSupplyModel";
import type { SupplyForecastGrant } from "../../shared/supplyForecastCandidate";
import { board11InvocationGate, board11MetadataEligible } from "./board11-policy";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { grantPlans, planGrants } from "./grants";
import type { FetchLike } from "./naver";
import { parseScheduleEvents } from "./naver";
import { fetchNotice } from "./notice";
import type { ProfileCounts } from "./profile";
import { type ReviewEvidence, reviewExcluded } from "./publication-exclusions";
import { loadRuntimeEvents } from "./runtime-events";
import { readScheduleLedger } from "./schedule-ledger";
import { collapseSoloSegments } from "./solo-interruptions";
import { judgments, soloLookup } from "./solo-judgment";
import { noticeTexts } from "./solo-sections";
import type {
  NormalizedSourceItem,
  ScheduleEvent,
  SourceQueueItem,
  SourceQueueResult,
} from "./types";

const constructedCandidates = new WeakSet<object>();
type ConstructedCandidate = NonNullable<Awaited<ReturnType<typeof buildNoticeCandidate>>>;

// This proof is an in-isolate object identity, never a serialized flag. Only
// the local v3 constructor can issue it, and the complete result is deep-frozen.
export function isConstructedNoticeCandidate(value: unknown): value is ConstructedCandidate {
  return typeof value === "object" && value !== null && constructedCandidates.has(value);
}

/**
 * Backend-only constructor for callers with their own confirmed-evidence policy.
 * Do not expose a generic branding API: serialized candidates must never acquire
 * this proof without going through the validating constructor.
 */
export async function buildConstructedForecastCandidate(
  eventId: string,
  ...args: Parameters<typeof buildForecastCandidate>
) {
  const envelope = await buildForecastCandidate(...args);
  const candidate = freezeJson({
    eventId,
    gameDay: envelope.candidate.forecastId.slice(7, 17),
    revision: args[4],
    envelope,
  });
  constructedCandidates.add(candidate);
  return candidate;
}

export async function processNotice(
  queued: SourceQueueItem,
  fetcher: FetchLike,
  counts?: ProfileCounts,
  db?: D1Database,
  board11Allowed = db ? board11InvocationGate(db) : async () => false,
  knownEvents?: () => Promise<ScheduleEvent[]>,
): Promise<SourceQueueResult> {
  const base = { source: queued.source, itemId: queued.itemId };
  if (!queued.official) return { ...base, outcome: "ignored", errorCode: "not_official_manager" };
  if (queued.source === "naver-board-11") {
    if (!board11MetadataEligible(queued.title, queued.official))
      return { ...base, outcome: "ignored", errorCode: "no_relevant_keyword" };
    if (!(await board11Allowed()))
      return { ...base, outcome: "retry", errorCode: "board11_schema_required" };
  }
  try {
    const item = await fetchNotice(
      queued.source === "naver-board-48" ? 48 : queued.source === "naver-board-11" ? 11 : 56,
      queued.itemId,
      fetcher,
      counts,
    );
    if (!item) return { ...base, outcome: "ignored", errorCode: "no_relevant_keyword" };
    if (item.url !== queued.url) throw new Error("naver_detail_url_mismatch");
    return await processFetchedNotice(item, base, db, board11Allowed, knownEvents);
  } catch (error) {
    const errorCode = noticeErrorCode(error);
    const retry = /^(naver_timeout|naver_network|naver_http_429|naver_http_5\d\d)$/.test(errorCode);
    return { ...base, outcome: retry ? "retry" : "manual_review", errorCode };
  }
}

async function processFetchedNotice(
  item: NormalizedSourceItem,
  base: Pick<SourceQueueResult, "source" | "itemId">,
  db: D1Database | undefined,
  board11Allowed: () => Promise<boolean>,
  knownEvents?: () => Promise<ScheduleEvent[]>,
): Promise<SourceQueueResult> {
  const lookup = soloLookup(item);
  const compensationOnly =
    item.source === "naver-board-11" &&
    /보상\s*(?:지급|안내)/.test(item.title) &&
    !/중단|재\s*오픈|재개|일정\s*변경|연장|진행\s*기간/.test(
      noticeTexts.get(item)?.effective ?? item.normalizedText,
    );
  const known =
    db && lookup.solo
      ? knownEvents
        ? await knownEvents()
        : await loadRuntimeEvents(db, (await readScheduleLedger(db, Date.now())).events)
      : [];
  const maintenance = await noticeMaintenance(db, lookup.dates);
  const events = compensationOnly ? [] : await parseScheduleEvents([item], { known, maintenance });
  if (db && (await board11Allowed())) {
    const result = await processNoticeGrants(
      db,
      item,
      base,
      events,
      lookup.solo,
      compensationOnly,
      board11Allowed,
    );
    if (result) return result;
  }
  return noticeEventResult(item, base, events);
}

async function noticeMaintenance(db: D1Database | undefined, dates: string[]) {
  const maintenance: { text: string; publishedAt: string }[] = [];
  if (db)
    for (const date of dates) {
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
  return maintenance;
}

async function processNoticeGrants(
  db: D1Database,
  item: NormalizedSourceItem,
  base: Pick<SourceQueueResult, "source" | "itemId">,
  events: ScheduleEvent[],
  solo: boolean,
  compensationOnly: boolean,
  board11Allowed: () => Promise<boolean>,
): Promise<SourceQueueResult | undefined> {
  const judged = judgments.get(item) ?? [];
  const plan = await planGrants(db, item, judged.length, undefined, undefined, board11Allowed);
  if (plan.judgments.length) judgments.set(item, [...judged, ...plan.judgments]);
  events.push(...plan.judgments.flatMap((entry) => (entry.event ? [entry.event] : [])));
  const unclear = plan.judgments.find((entry) => entry.comparison.blocking);
  if (unclear)
    return {
      ...base,
      outcome: "manual_review",
      errorCode: unclear.reason ?? "grant_unclear",
      item,
      events,
    };
  if (
    item.source === "naver-board-11" &&
    (!solo || compensationOnly) &&
    plan.judgments.length === 0
  ) {
    judgments.set(item, [
      {
        blockIndex: 0,
        verdict: "ignored",
        reason: "no_kit_grant",
        question: "관리 키트 지급 항목 없음",
        triggers: [],
        blockExcerpt: item.excerpt,
        maintenanceInputs: [],
        comparison: {
          known: null,
          extracted: null,
          equal: false,
          segments: [],
          blocking: false,
        },
      },
    ]);
    return { ...base, outcome: "ignored", errorCode: "no_kit_grant", item };
  }
  if (plan.grants.length && !events.length) return { ...base, outcome: "processed", item, events };
}

function noticeEventResult(
  item: NormalizedSourceItem,
  base: Pick<SourceQueueResult, "source" | "itemId">,
  events: ScheduleEvent[],
): SourceQueueResult {
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
    events,
  };
}

export async function buildNoticeCandidate(
  previous: readonly ScheduleEvent[],
  results: readonly SourceQueueResult[],
  nowMs: number,
  revision: number,
  existingGrants: readonly SupplyForecastGrant[] = [],
  persistedReviews: readonly ReviewEvidence[] = [],
  ignoredSources: ReadonlySet<string> = new Set(),
) {
  if (
    results.some(
      (result) =>
        result.outcome === "retry" || (result.outcome === "manual_review" && !result.item),
    )
  )
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
  // Contradictory overlapping official intervals must not be silently deduplicated.
  assertSoloIntervals(events);
  const currentReviews = results
    .filter((result) => result.outcome === "manual_review" && result.item)
    .map((result) => ({
      item: result.item as NonNullable<typeof result.item>,
      judgments: judgments.get(result.item as NonNullable<typeof result.item>) ?? [],
    }));
  const resolved = resolveSoloSchedule(events, nowMs);
  if (!resolved) return undefined;
  const envelope = await buildForecastCandidate(
    resolved,
    events,
    { status: "x_unavailable", sourceItem: null, reason: "runtime_advisory_pending" },
    nowMs,
    revision,
    [
      ...new Map(
        [
          ...existingGrants,
          ...results.flatMap((result) =>
            result.item ? (grantPlans.get(result.item)?.grants ?? []) : [],
          ),
        ].map((grant) => [grant.id, grant]),
      ).values(),
    ],
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
  const grants = candidate.envelope.candidate.grants ?? [];
  const horizon = candidate.envelope.candidate.certifiedSnapshot?.coverage;
  if (!horizon) return undefined;
  for (const review of currentReviews)
    if (!(await reviewExcluded(review, events, grants, horizon, true))) return undefined;
  for (const review of persistedReviews)
    if (
      !(await reviewExcluded(review, events, grants, horizon, Boolean(review.publicationBinding)))
    )
      return undefined;
  // Runtime preflight applies this same predicate before resolution/construction.
  // Retain the constructor's final defence and historical validation/error
  // precedence for other callers that supply current-run result overlays.
  if (hasUnreviewedNoticeEvents(events, [...currentReviews, ...persistedReviews], ignoredSources))
    return undefined;
  constructedCandidates.add(candidate);
  return candidate;
}

export function hasUnreviewedNoticeEvents(
  events: readonly ScheduleEvent[],
  reviews: readonly ReviewEvidence[],
  ignoredSources: ReadonlySet<string> = new Set(),
) {
  const reviewed = new Set([
    ...ignoredSources,
    ...reviews.map((review) => `${review.item.source}:${review.item.itemId}`),
  ]);
  return events.some(
    (event) =>
      event.manualReview &&
      event.reason !== "runtime_notice_replaced" &&
      !reviewed.has(`${event.sourceItem.source}:${event.sourceItem.itemId}`),
  );
}

function assertSoloIntervals(events: ScheduleEvent[]) {
  const solos = collapseSoloSegments(events)
    .filter(
      (event) =>
        event.eventType === "solo" &&
        // Stored cadence estimates are not official intervals and never feed
        // resolveSoloSchedule; a later confirmed notice may overlap them.
        event.scheduleStatus === "confirmed" &&
        !event.manualReview &&
        event.startsAt &&
        event.endsAt,
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
}

export function noticeErrorCode(error: unknown) {
  return (
    (error instanceof Error ? error.message : "unknown")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80) || "unknown"
  );
}
