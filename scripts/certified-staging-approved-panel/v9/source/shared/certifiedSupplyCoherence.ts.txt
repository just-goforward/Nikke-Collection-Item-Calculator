import {
  type CertifiedSoloRound,
  type CertifiedSoloSegment,
  type CertifiedSupplySnapshot,
  DAY_MS,
  dateStart,
  freezeJson,
  isDeeplyFrozen,
  timestamp,
} from "./certifiedSupplyModel.ts";
import {
  knownArrayFields,
  knownFields,
  textList,
  validateSnapshot,
} from "./certifiedSupplyValidation.ts";
import { gameDayKey, gameDayStartCeilMs } from "./gameDay.ts";

/** Full admission checks for builders and publication; not part of browser admission. */
const coherentSnapshots = new WeakSet<object>();

export function isCoherentSnapshot(value: unknown): value is ReturnType<typeof validateSnapshot> {
  return typeof value === "object" && value !== null && coherentSnapshots.has(value);
}

export function freezeCoherentSnapshot(value: unknown) {
  const snapshot = freezeJson(assertSupplyCoherence(value));
  coherentSnapshots.add(snapshot);
  return snapshot;
}

export function assertSupplyCoherence(value: unknown) {
  if (isCoherentSnapshot(value)) return value;
  const snapshot = validateSnapshot(value);
  assertGrantEvents(snapshot);
  for (const round of snapshot.soloRounds) assertRoundSegments(snapshot, round);
  if (isDeeplyFrozen(snapshot)) coherentSnapshots.add(snapshot);
  return snapshot;
}

function assertGrantEvents(snapshot: CertifiedSupplySnapshot) {
  for (const event of snapshot.events) {
    if (event.kind !== "grant") continue;
    if (
      timestamp(event.at) !== dateStart(event.gameDate) ||
      event.id.split(":")[3] !== event.gameDate ||
      typeof event.claimWindowAssumed !== "boolean" ||
      !textList(event.sourceIds) ||
      !event.sourceIds?.length ||
      !textList(event.restatementOf) ||
      event.refs.length === 0 ||
      event.refs.some((ref) => ref.count < 1)
    )
      throw new Error("certified_grant_invalid");
  }
}

function assertRoundSegments(snapshot: CertifiedSupplySnapshot, round: CertifiedSoloRound) {
  if (round.segments === undefined) return;
  if (!Array.isArray(round.segments) || !round.segments.length)
    throw new Error("certified_solo_segments_invalid");
  knownArrayFields(round.segments);
  for (const [index, segment] of round.segments.entries()) {
    assertSegment(segment, index, round.segments[index - 1]);
  }
  if (
    round.segments[0]?.rewardFromGameDate !== round.startGameDate ||
    round.segments.at(-1)?.rewardUntilGameDate !== round.endGameDate
  )
    throw new Error("certified_solo_segments_round_invalid");
  assertSegmentEvents(snapshot, round, round.segments);
}

function assertSegment(
  segment: CertifiedSoloSegment,
  index: number,
  previous: CertifiedSoloSegment | undefined,
) {
  knownFields(
    segment,
    "segment kind effectiveFrom effectiveUntil rewardFromGameDate rewardUntilGameDate sourceIds",
  );
  const from = timestamp(segment.effectiveFrom);
  const until = timestamp(segment.effectiveUntil);
  const rewardFrom = dateStart(segment.rewardFromGameDate);
  const rewardUntil = dateStart(segment.rewardUntilGameDate);
  if (
    segment.segment !== index + 1 ||
    segment.kind !== (index === 0 ? "initial" : "reopen") ||
    until <= from ||
    rewardUntil <= rewardFrom ||
    gameDayKey(from) !== segment.rewardFromGameDate ||
    rewardUntil > gameDayStartCeilMs(until) ||
    rewardUntil - DAY_MS >= until ||
    !textList(segment.sourceIds) ||
    segment.sourceIds.length === 0 ||
    (previous &&
      (from < timestamp(previous.effectiveUntil) ||
        rewardFrom < dateStart(previous.rewardUntilGameDate)))
  )
    throw new Error("certified_solo_segments_invalid");
}

function assertSegmentEvents(
  snapshot: CertifiedSupplySnapshot,
  round: CertifiedSoloRound,
  segments: readonly CertifiedSoloSegment[],
) {
  for (const event of snapshot.events.filter(
    (event) => event.kind === "solo" && event.round === round.round,
  )) {
    const segment = segments.find((entry) => entry.segment === event.segment);
    if (
      !segment ||
      event.gameDate !==
        gameDayKey(dateStart(segment.rewardFromGameDate) + ((event.dayNumber ?? 0) - 1) * DAY_MS) ||
      dateStart(event.gameDate) >= dateStart(segment.rewardUntilGameDate) ||
      timestamp(event.at) !==
        Math.max(dateStart(event.gameDate), timestamp(segment.effectiveFrom)) ||
      event.expiresAt !== segment.effectiveUntil
    )
      throw new Error("certified_solo_event_segment_invalid");
  }
}
