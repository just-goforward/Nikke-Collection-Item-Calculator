import { createCertifiedSupplyRule } from "../../shared/certifiedSupplyModel";
import { gameDayStartCeilMs, gameDayStartMs } from "../../shared/gameDay";
import { deriveSoloRaidCadenceDays, SOLO_RAID_CADENCE_SUMMARY } from "../../shared/soloRaidCadence";
import { buildScheduleForecastSnapshot } from "../../shared/supplyForecastBuild";
import {
  buildSupplyForecastCandidate,
  type SupplyForecastGrant,
  type SupplyForecastV5SoloPeriod,
} from "../../shared/supplyForecastCandidate";
import {
  DISPATCH_POLICY_ID,
  SUPPLY_PROFILE_HORIZON_DAYS,
  SUPPLY_RULES_VERSION,
} from "../../shared/supplyForecastProjection";
import { sha256Hex, stableJson } from "./crypto";
import { collapseSoloSegments, eventRound } from "./solo-interruptions";
import type {
  CandidateBuildResult,
  NormalizedSourceItem,
  ScheduleEvent,
  XProbeResult,
} from "./types";

const DAY_MS = 86_400_000;
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
  const solo = collapseSoloSegments(events)
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
  const liveStartGameDates = solo.map((event) =>
    new Date(gameDayStartMs(Date.parse(event.startsAt)) + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
  );
  const cadenceMs = deriveSoloRaidCadenceDays(liveStartGameDates) * DAY_MS;

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
    evidenceEvents: uniqueStarts.flatMap((event) =>
      event.segments
        ? events.filter(
            (source) =>
              source.eventType === "solo" &&
              !source.manualReview &&
              eventRound(source) === eventRound(event),
          )
        : [event],
    ),
  };
}

export async function buildForecastCandidate(
  resolved: ResolvedSchedule,
  scheduleEvents: readonly ScheduleEvent[],
  xProbe: XProbeResult,
  nowMs: number,
  revision: number,
  grants: readonly SupplyForecastGrant[] = [],
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
  const deduplicatedEvidence = candidateEvidence(sourceEvidence);
  const collaborationPeriods = relevantCollaborationEvents
    .map((event) => ({ effectiveFrom: event.startsAt, effectiveUntil: event.endsAt }))
    .filter(uniquePeriod)
    // These periods contain only start and end; there are no remaining fields.
    // Do not depend on loadScheduleEvents' descending, start-only SQL ordering.
    .sort(
      (left, right) =>
        left.effectiveFrom.localeCompare(right.effectiveFrom) ||
        left.effectiveUntil.localeCompare(right.effectiveUntil),
    );
  const identity = stableJson({
    grants,
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
  const sourceHash = await sha256Hex(identity);
  const certifiedSnapshot = buildScheduleForecastSnapshot({
    grants: grants.map(({ claimUntil, ...grant }) => ({
      ...grant,
      ...(claimUntil === undefined ? {} : { claimUntil }),
    })),
    asOf: generatedAt,
    revision: sourceHash,
    sourceHash,
    sourceStatus: "uncertain",
    soloPeriods: resolved.soloEvents.filter(hasConcreteSchedule).map(snapshotSoloPeriod),
    collaborationPeriods,
    provenance: deduplicatedEvidence.map((evidence) => evidence.url).sort(),
  });
  if (certifiedSnapshot.version !== "certified-daily-v4")
    throw new Error("forecast_snapshot_version");
  const ledgerPeriods = candidateLedgerPeriods(certifiedSnapshot);
  const primary =
    ledgerPeriods.find(
      (period) =>
        resolved.event.segments &&
        period.round === eventRound(resolved.event) &&
        Date.parse(period.effectiveUntil) > nowMs,
    ) ??
    ledgerPeriods.find((period) => period.effectiveFrom === resolved.event.startsAt) ??
    ledgerPeriods.find((period) => Date.parse(period.effectiveUntil) > nowMs);
  if (!primary) throw new Error("forecast_primary_period_missing");
  const ledgerHash = await sha256Hex(stableJson(certifiedSnapshot));
  const candidateId = `forecast-${(
    await sha256Hex(stableJson({ rulesVersion: SUPPLY_RULES_VERSION, sourceHash, ledgerHash }))
  ).slice(0, 24)}`;
  const candidate = buildSupplyForecastCandidate({
    candidateId,
    forecastId,
    dispatchPolicyId: DISPATCH_POLICY_ID,
    generatedAt,
    sourceStatus: xProbe.status,
    schedule: {
      status: resolved.scheduleStatus,
      cadenceDays: resolved.cadenceDays,
      soloStart: primary.effectiveFrom,
      soloEnd: primary.effectiveUntil,
      soloPeriods: ledgerPeriods,
      collaborationPeriods,
    },
    sourceEvidence: deduplicatedEvidence,
    certifiedSnapshot: certifiedSnapshot as typeof certifiedSnapshot & {
      version: "certified-daily-v4";
    },
    grants: [...grants],
    warnings: candidateWarnings(soloPeriods, resolved.cadenceDays, xProbe.status),
  });
  return { candidate, payloadHash: await sha256Hex(stableJson(candidate)) };
}

function candidateWarnings(
  soloPeriods: ReturnType<typeof schedulePeriod>[],
  cadenceDays: number | null,
  status: XProbeResult["status"],
) {
  return [
    ...(soloPeriods.some((period) => period.scheduleStatus === "estimated")
      ? ["Some Solo Raid reference windows use cadence estimates."]
      : []),
    ...(cadenceDays === null
      ? ["New-round cadence could not be derived from the available history."]
      : []),
    ...(status === "x_unavailable"
      ? ["X is advisory and is evaluated during proposal review."]
      : []),
    ...(status === "conflict" ? ["Official sources report conflicting schedules."] : []),
  ];
}

function snapshotSoloPeriod(event: ConcreteScheduleEvent) {
  return {
    ...schedulePeriod(event),
    ...(event.segments?.[0] ? { round: event.segments[0].round } : {}),
    segments: (
      event.segments ?? [
        {
          segment: 1,
          kind: "initial" as const,
          effectiveFrom: event.startsAt,
          effectiveUntil: event.endsAt,
        },
      ]
    ).map((segment) => ({
      segment: segment.segment,
      kind: segment.kind === "suspend" ? ("initial" as const) : segment.kind,
      effectiveFrom: segment.effectiveFrom,
      effectiveUntil: segment.effectiveUntil,
      rewardFromGameDate: new Date(gameDayStartMs(Date.parse(segment.effectiveFrom)) + 9 * 3600000)
        .toISOString()
        .slice(0, 10),
      rewardUntilGameDate: new Date(
        Math.min(
          gameDayStartCeilMs(Date.parse(segment.effectiveUntil)),
          gameDayStartMs(Date.parse(segment.effectiveFrom)) +
            createCertifiedSupplyRule(segment.effectiveFrom).soloDays.length * DAY_MS,
        ) +
          9 * 3600000,
      )
        .toISOString()
        .slice(0, 10),
      sourceIds: [event.sourceItem.url],
    })),
  };
}

function candidateLedgerPeriods(snapshot: ReturnType<typeof buildScheduleForecastSnapshot>) {
  return snapshot.soloRounds.flatMap((round): SupplyForecastV5SoloPeriod[] => {
    if (round.segments)
      return round.segments.map((segment) => ({
        round: round.round,
        segment: segment.segment,
        effectiveFrom: segment.effectiveFrom,
        effectiveUntil: segment.effectiveUntil,
        scheduleStatus: "confirmed",
      }));
    if (round.status !== "estimated" || !round.endGameDate) return [];
    const start = (date: string) => new Date(`${date}T05:00:00+09:00`).toISOString();
    return [
      {
        round: round.round,
        segment: 1,
        effectiveFrom: start(round.startGameDate),
        effectiveUntil: start(round.endGameDate),
        scheduleStatus: "estimated",
      },
    ];
  });
}

function candidateEvidence(sourceEvidence: readonly NormalizedSourceItem[]) {
  const evidenceByKey = new Map<string, NormalizedSourceItem>();
  for (const item of sourceEvidence) {
    const key = `${item.source}:${item.itemId}`;
    const previous = evidenceByKey.get(key);
    if (previous && previous.contentHash !== item.contentHash) {
      throw new Error("candidate_source_content_hash_conflict");
    }
    evidenceByKey.set(key, item);
  }
  return [...evidenceByKey.values()].map((item) => ({
    source: item.source,
    itemId: item.itemId,
    url: item.url,
    publishedAt: item.publishedAt,
    excerpt: item.excerpt,
    contentHash: item.contentHash,
  }));
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
      excerpt: `${SOLO_RAID_CADENCE_SUMMARY.rounds} official new-round starts plus ${evidenceCount} live evidence item(s); median interval ${cadenceMs / DAY_MS} days.`,
    },
    startsAt: start,
    endsAt: new Date(startMs + durationMs).toISOString(),
    scheduleStatus: "estimated",
    manualReview: false,
    reason: "full_round_history_median",
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

function hasConcreteSchedule(event: ScheduleEvent): event is ConcreteScheduleEvent {
  return event.startsAt !== null && event.endsAt !== null;
}

function requireTimestamp(value: string | null, label: string) {
  if (value === null) throw new Error(`${label} is missing.`);
  return value;
}
