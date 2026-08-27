import {
  assertForecastCandidateInvariants,
  SUPPLY_FORECAST_CANDIDATE_PAYLOAD_VERSION,
  supplyForecastCandidateSchema,
} from "../../shared/supplyForecastCandidate";
import {
  buildScheduleForecastProfiles,
  DISPATCH_POLICY_ID,
  gameDayStartCeilMs,
  gameDayStartMs,
  SUPPLY_PROFILE_HORIZON_DAYS,
  SUPPLY_RULES_VERSION,
} from "../../shared/supplyForecastModel";
import { sha256Hex, stableJson } from "./crypto";
import type { CandidateBuildResult, ScheduleEvent, XProbeResult } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_DAYS = 28;
type ConcreteScheduleEvent = ScheduleEvent & { startsAt: string; endsAt: string };

export type ResolvedSchedule = {
  event: ScheduleEvent;
  soloEvents: ScheduleEvent[];
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
    .filter(
      (event, index, values) =>
        values.findIndex((other) => other.startsAt === event.startsAt) === index,
    )
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  if (solo.length === 0) return null;
  const activeOrFutureIndex = solo.findIndex(
    (event) => gameDayStartCeilMs(Date.parse(event.endsAt)) > nowMs,
  );
  const activeOrFuture = solo[activeOrFutureIndex];
  const uniqueStarts = solo.slice(-6);
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

  let focus: ConcreteScheduleEvent;
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
    focus = activeOrFuture;
  } else {
    const latest = uniqueStarts.at(-1);
    if (!latest) return null;
    let estimatedStart = Date.parse(latest.startsAt) + cadenceMs;
    while (estimatedStart <= nowMs) estimatedStart += cadenceMs;
    focus = estimatedSoloEvent(latest, estimatedStart, cadenceMs, uniqueStarts.length);
  }

  const soloEvents = [...uniqueStarts];
  if (!soloEvents.some((event) => event.startsAt === focus.startsAt)) soloEvents.push(focus);
  soloEvents.sort(
    (left, right) =>
      Date.parse(requireTimestamp(left.startsAt, "Solo Raid start")) -
      Date.parse(requireTimestamp(right.startsAt, "Solo Raid start")),
  );

  const first = soloEvents[0];
  if (
    first &&
    Date.parse(requireTimestamp(first.startsAt, "Solo Raid start")) >=
      Date.parse(requireTimestamp(focus.startsAt, "Solo Raid start"))
  ) {
    const previousStart =
      Date.parse(requireTimestamp(first.startsAt, "Solo Raid start")) - cadenceMs;
    soloEvents.unshift(estimatedSoloEvent(first, previousStart, cadenceMs, uniqueStarts.length));
  }
  const requiredUntil = nowMs + (SUPPLY_PROFILE_HORIZON_DAYS * DAY_MS + cadenceMs);
  let latest = soloEvents.at(-1);
  while (
    latest &&
    Date.parse(requireTimestamp(latest.startsAt, "Solo Raid start")) < requiredUntil
  ) {
    const nextStart = Date.parse(requireTimestamp(latest.startsAt, "Solo Raid start")) + cadenceMs;
    const next = estimatedSoloEvent(latest, nextStart, cadenceMs, uniqueStarts.length);
    soloEvents.push(next);
    latest = next;
  }

  return {
    event: focus,
    soloEvents,
    scheduleStatus: focus.scheduleStatus,
    cadenceDays: cadenceMs / DAY_MS,
    evidenceEvents: uniqueStarts,
  };
}

export async function buildForecastCandidate(
  resolved: ResolvedSchedule,
  scheduleEvents: readonly ScheduleEvent[],
  xProbe: XProbeResult,
  nowMs: number,
  revision: number,
): Promise<CandidateBuildResult> {
  const gameDayStart = gameDayStartMs(nowMs);
  const generatedAt = new Date(gameDayStart).toISOString();
  const forecastDate = new Date(gameDayStart + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const forecastId = `supply-${forecastDate}-v${revision}`;
  const soloPeriods = resolved.soloEvents.filter(hasConcreteSchedule).map(schedulePeriod);
  const referenceStart = gameDayStartMs(Date.parse(soloPeriods[0]?.effectiveFrom ?? generatedAt));
  const referenceEnd = gameDayStartMs(
    Date.parse(soloPeriods.at(-1)?.effectiveUntil ?? generatedAt),
  );
  const relevantCollaborationEvents = scheduleEvents
    .filter(
      (event): event is ConcreteScheduleEvent => !event.manualReview && hasConcreteSchedule(event),
    )
    .filter(
      (event) =>
        Date.parse(event.endsAt) >= referenceStart && Date.parse(event.startsAt) <= referenceEnd,
    )
    .filter(
      (event) =>
        event.scheduleStatus === "confirmed" &&
        (event.eventType === "collaboration" ||
          (event.eventType === "cooperation" && /콜라보/.test(event.sourceItem.normalizedText))),
    );
  const sourceEvidence = [
    ...resolved.evidenceEvents.map((event) => event.sourceItem),
    ...relevantCollaborationEvents.map((event) => event.sourceItem),
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
  const collaborationPeriods = relevantCollaborationEvents
    .map((event) => ({ effectiveFrom: event.startsAt, effectiveUntil: event.endsAt }))
    .filter(uniquePeriod);
  const profiles = buildScheduleForecastProfiles({
    forecastId,
    effectiveFrom: generatedAt,
    soloPeriods,
    collaborationPeriods,
  });
  const identity = stableJson({
    forecastDate,
    schedule: {
      status: resolved.scheduleStatus,
      cadenceDays: resolved.cadenceDays,
      soloStart: resolved.event.startsAt,
      soloEnd: resolved.event.endsAt,
      soloPeriods,
      collaborationPeriods,
    },
    sourceStatus: xProbe.status,
    sourceHashes: deduplicatedEvidence.map((evidence) => evidence.contentHash).sort(),
  });
  const candidateId = `forecast-${(await sha256Hex(identity)).slice(0, 24)}`;
  const candidate = supplyForecastCandidateSchema.parse({
    payloadVersion: SUPPLY_FORECAST_CANDIDATE_PAYLOAD_VERSION,
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
      soloPeriods,
      collaborationPeriods,
    },
    sourceEvidence: deduplicatedEvidence,
    profiles,
    warnings: [
      ...(soloPeriods.some((period) => period.scheduleStatus === "estimated")
        ? ["Some Solo Raid reference windows use cadence estimates."]
        : []),
      ...(resolved.cadenceDays === null
        ? ["New-round cadence could not be derived from the available history."]
        : []),
      ...(xProbe.status === "x_unavailable"
        ? ["X is advisory and is evaluated during proposal review."]
        : []),
      ...(xProbe.status === "conflict" ? ["Official sources report conflicting schedules."] : []),
    ],
  });
  assertForecastCandidateInvariants(candidate);
  return { candidate, payloadHash: await sha256Hex(stableJson(candidate)) };
}

function estimatedSoloEvent(
  base: ScheduleEvent,
  startMs: number,
  cadenceMs: number,
  evidenceCount: number,
): ConcreteScheduleEvent {
  const durationMs =
    Date.parse(requireTimestamp(base.endsAt, "Solo Raid end")) -
    Date.parse(requireTimestamp(base.startsAt, "Solo Raid start"));
  const start = new Date(startMs).toISOString();
  return {
    eventId: `${base.eventId}:estimated:${start}`,
    eventType: "solo",
    sourceItem: {
      ...base.sourceItem,
      itemId: `${base.sourceItem.itemId}:estimated:${start.slice(0, 10)}`,
      title: `Estimated from recent Solo Raid cadence: ${base.sourceItem.title}`,
      excerpt: `Recent ${evidenceCount} new-round starts; median interval ${cadenceMs / DAY_MS} days.`,
    },
    startsAt: start,
    endsAt: new Date(startMs + durationMs).toISOString(),
    scheduleStatus: "estimated",
    manualReview: false,
    reason: "recent_six_start_median",
  };
}

function schedulePeriod(event: ScheduleEvent & { startsAt: string; endsAt: string }) {
  return {
    effectiveFrom: event.startsAt,
    effectiveUntil: event.endsAt,
    scheduleStatus: event.scheduleStatus,
  };
}

function uniquePeriod<T extends { effectiveFrom: string; effectiveUntil: string }>(
  period: T,
  index: number,
  periods: readonly T[],
) {
  return (
    periods.findIndex(
      (other) =>
        other.effectiveFrom === period.effectiveFrom &&
        other.effectiveUntil === period.effectiveUntil,
    ) === index
  );
}

function median(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function hasConcreteSchedule(event: ScheduleEvent): event is ConcreteScheduleEvent {
  return event.startsAt !== null && event.endsAt !== null;
}

function requireTimestamp(value: string | null, label: string) {
  if (value === null) throw new Error(`${label} is missing.`);
  return value;
}
