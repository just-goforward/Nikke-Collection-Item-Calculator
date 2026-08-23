import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateSchema,
} from "../../shared/supplyForecastCandidate";
import {
  buildScheduleForecastProfiles,
  DISPATCH_POLICY_ID,
  gameDayStartMs,
  SUPPLY_RULES_VERSION,
} from "../../shared/supplyForecastModel";
import { sha256Hex, stableJson } from "./crypto";
import type {
  CandidateBuildResult,
  NormalizedSourceItem,
  ScheduleEvent,
  XProbeResult,
} from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_DAYS = 28;

export type ResolvedSchedule = {
  event: ScheduleEvent;
  scheduleStatus: "confirmed" | "estimated";
  cadenceDays: number | null;
  evidenceEvents: ScheduleEvent[];
};

export function resolveSoloSchedule(
  events: readonly ScheduleEvent[],
  nowMs: number,
): ResolvedSchedule | null {
  const solo = events
    .filter(
      (event) =>
        event.eventType === "solo" && event.scheduleStatus === "confirmed" && !event.manualReview,
    )
    .filter(hasConcreteSchedule)
    .toSorted((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const activeOrFutureIndex = solo.findIndex(
    (event) => gameDayStartMs(Date.parse(event.startsAt)) + 3 * DAY_MS > nowMs,
  );
  const activeOrFuture = solo[activeOrFutureIndex];
  if (activeOrFuture) {
    const previous = solo[activeOrFutureIndex - 1];
    const cadenceDays = previous
      ? (gameDayStartMs(Date.parse(activeOrFuture.startsAt)) -
          gameDayStartMs(Date.parse(previous.startsAt))) /
        DAY_MS
      : null;
    if (
      cadenceDays !== null &&
      (!Number.isInteger(cadenceDays) || cadenceDays < 21 || cadenceDays > 35)
    ) {
      throw new Error("confirmed_solo_cadence_out_of_range");
    }
    return {
      event: activeOrFuture,
      scheduleStatus: "confirmed",
      cadenceDays,
      evidenceEvents: previous ? [previous, activeOrFuture] : [activeOrFuture],
    };
  }
  const uniqueStarts = [...new Map(solo.map((event) => [event.startsAt, event])).values()].slice(
    -6,
  );
  const latest = uniqueStarts.at(-1);
  if (!latest?.startsAt || !latest.endsAt) return null;
  const intervals = uniqueStarts.slice(1).map((event, index) => {
    const previous = uniqueStarts[index];
    return previous
      ? gameDayStartMs(Date.parse(event.startsAt)) - gameDayStartMs(Date.parse(previous.startsAt))
      : 0;
  });
  const medianMs = median(
    intervals.filter((value) => value >= 21 * DAY_MS && value <= 35 * DAY_MS),
  );
  const cadenceMs = medianMs ?? DEFAULT_INTERVAL_DAYS * DAY_MS;
  let estimatedStart = Date.parse(latest.startsAt) + cadenceMs;
  while (estimatedStart <= nowMs) estimatedStart += cadenceMs;
  const durationMs = Date.parse(latest.endsAt) - Date.parse(latest.startsAt);
  const estimatedEnd = estimatedStart + durationMs;
  const sourceItem: NormalizedSourceItem = {
    ...latest.sourceItem,
    itemId: `${latest.sourceItem.itemId}:estimated`,
    title: `Estimated from recent Solo Raid cadence: ${latest.sourceItem.title}`,
    excerpt: `Recent ${uniqueStarts.length} new-round starts; median interval ${cadenceMs / DAY_MS} days.`,
  };
  return {
    event: {
      eventId: `${latest.eventId}:estimated:${new Date(estimatedStart).toISOString()}`,
      eventType: "solo",
      sourceItem,
      startsAt: new Date(estimatedStart).toISOString(),
      endsAt: new Date(estimatedEnd).toISOString(),
      scheduleStatus: "estimated",
      manualReview: false,
      reason: "recent_six_start_median",
    },
    scheduleStatus: "estimated",
    cadenceDays: cadenceMs / DAY_MS,
    evidenceEvents: uniqueStarts,
  };
}

export async function buildForecastCandidate(
  resolved: ResolvedSchedule,
  collaborationEvents: readonly ScheduleEvent[],
  xProbe: XProbeResult,
  nowMs: number,
  revision: number,
): Promise<CandidateBuildResult> {
  const gameDayStart = gameDayStartMs(nowMs);
  const generatedAt = new Date(gameDayStart).toISOString();
  const forecastDate = new Date(gameDayStart + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const forecastId = `supply-${forecastDate}-v${revision}`;
  const sourceEvidence = [
    ...resolved.evidenceEvents.map((event) => event.sourceItem),
    ...collaborationEvents.map((event) => event.sourceItem),
  ];
  if (xProbe.sourceItem) sourceEvidence.push(xProbe.sourceItem);
  const deduplicatedEvidence = [
    ...new Map(sourceEvidence.map((item) => [`${item.source}:${item.itemId}`, item])).values(),
  ].map((item) => ({
    source: item.source,
    itemId: item.itemId,
    url: item.url,
    publishedAt: item.publishedAt,
    excerpt: item.excerpt,
    contentHash: item.contentHash,
  }));
  const collaborationPeriods = collaborationEvents
    .filter((event) => event.eventType === "collaboration" && !event.manualReview)
    .filter(hasConcreteSchedule)
    .map((event) => ({ effectiveFrom: event.startsAt, effectiveUntil: event.endsAt }));
  const profiles = buildScheduleForecastProfiles({
    forecastId,
    effectiveFrom: generatedAt,
    nextSoloStart: requireTimestamp(resolved.event.startsAt, "resolved Solo Raid start"),
    scheduleStatus: resolved.scheduleStatus,
    collaborationPeriods,
  });
  const identity = stableJson({
    schedule: {
      status: resolved.scheduleStatus,
      cadenceDays: resolved.cadenceDays,
      soloStart: resolved.event.startsAt,
      soloEnd: resolved.event.endsAt,
      collaborationPeriods,
    },
    sourceStatus: xProbe.status,
    sourceHashes: deduplicatedEvidence.map((evidence) => evidence.contentHash).toSorted(),
  });
  const candidateId = `forecast-${(await sha256Hex(identity)).slice(0, 24)}`;
  const candidate = supplyForecastCandidateSchema.parse({
    payloadVersion: 2,
    candidateId,
    forecastId,
    rulesVersion: SUPPLY_RULES_VERSION,
    dispatchPolicyId: DISPATCH_POLICY_ID,
    generatedAt,
    sourceStatus: xProbe.status,
    schedule: {
      status: resolved.scheduleStatus,
      cadenceDays: resolved.cadenceDays,
      soloStart: resolved.event.startsAt,
      soloEnd: resolved.event.endsAt,
      collaborationPeriods,
    },
    sourceEvidence: deduplicatedEvidence,
    profiles,
    warnings: [
      ...(resolved.scheduleStatus === "estimated" ? ["Next Solo Raid schedule is estimated."] : []),
      ...(resolved.cadenceDays === null
        ? ["New-round cadence could not be derived from the available history."]
        : []),
      ...(xProbe.status === "x_unavailable"
        ? ["X could not be cross-checked automatically; manual confirmation is required."]
        : []),
      ...(xProbe.status === "conflict" ? ["Official sources report conflicting schedules."] : []),
    ],
  });
  assertForecastCandidateInvariants(candidate);
  return { candidate, payloadHash: await sha256Hex(stableJson(candidate)) };
}

function median(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function hasConcreteSchedule(
  event: ScheduleEvent,
): event is ScheduleEvent & { startsAt: string; endsAt: string } {
  return event.startsAt !== null && event.endsAt !== null;
}

function requireTimestamp(value: string | null, label: string) {
  if (value === null) throw new Error(`${label} is missing.`);
  return value;
}
