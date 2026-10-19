import { createCertifiedSupplyRule } from "../../shared/certifiedSupplyModel";
import { SOLO_RAID_ROUND_HISTORY } from "../../shared/soloRaidCadence";
import type { Judgment, SoloContext } from "./solo-contracts";
import type { NormalizedSourceItem, ScheduleEvent, SoloSegment } from "./types";

export function eventRound(event: ScheduleEvent) {
  if (event.segment) return event.segment.round;
  if (event.segments?.[0]) return event.segments[0].round;
  if (!event.startsAt) return undefined;
  const date = new Date(Date.parse(event.startsAt) + 4 * 3600000).toISOString().slice(0, 10);
  return SOLO_RAID_ROUND_HISTORY.find((round) => round.startGameDate === date)?.round;
}

function segmentComparison(segment: SoloSegment) {
  const kst = (date: string) =>
    `${new Date(Date.parse(date) + 9 * 3600000).toISOString().slice(0, 19)}+09:00`;
  return {
    segment: segment.segment,
    kind: segment.kind === "suspend" ? "initial" : segment.kind,
    startKst: kst(segment.effectiveFrom),
    endKst: kst(segment.effectiveUntil),
    rewardDays: Math.min(
      createCertifiedSupplyRule(segment.effectiveFrom).soloDays.length,
      Math.ceil((Date.parse(segment.effectiveUntil) + 4 * 3600000) / 86400000) -
        Math.floor((Date.parse(segment.effectiveFrom) + 4 * 3600000) / 86400000),
    ),
  };
}

function reopenSegment(
  effective: string,
  known: ScheduleEvent[],
  matchingBoss: (event: ScheduleEvent) => boolean,
  range: { start: string; end: string } | null,
) {
  let segment: SoloSegment | undefined;
  const explicitRound = /솔로\s*레이드(?:\s*재오픈)?\s*(?:\(\s*)?시즌\s*(\d+)/.exec(effective)?.[1];
  const matches = known.filter(
    (event) =>
      event.segment?.kind === "suspend" &&
      matchingBoss(event) &&
      (!explicitRound || event.segment.round === Number(explicitRound)),
  );
  const rounds = new Set(matches.map((event) => event.segment?.round));
  const suspended = matches[0]?.segment;
  if (
    range &&
    rounds.size === 1 &&
    suspended &&
    Date.parse(range.start) > Date.parse(suspended.effectiveUntil)
  ) {
    segment = {
      round: suspended.round,
      segment: suspended.segment + 1,
      kind: "reopen",
      effectiveFrom: range.start,
      effectiveUntil: range.end,
    };
  }
  return { segment, matches };
}

function suspensionInstants(effective: string, publishedAt: string) {
  const lines = effective.split("\n");
  const instants = new Set<string>();
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (!/중단/.test(line)) continue;
    const input = /중단\s*일시/.test(line) ? `${line}\n${lines[at + 1] ?? ""}` : line;
    const match =
      /(\d{1,2})[월/]\s*(\d{1,2})일?(?:\([^)]*\))?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(input);
    if (match) {
      const year = new Date(Date.parse(publishedAt) + 9 * 3600000).getUTCFullYear();
      const stamp = `${year}-${match[1]?.padStart(2, "0")}-${match[2]?.padStart(2, "0")}T${match[3]?.padStart(2, "0")}:${match[4]}:${match[5] ?? "00"}+09:00`;
      const parsed = Date.parse(stamp);
      if (
        Number.isFinite(parsed) &&
        new Date(parsed + 9 * 3600000).toISOString().slice(0, 19) === stamp.slice(0, 19)
      )
        instants.add(new Date(parsed).toISOString());
    }
  }
  return instants;
}

function suspensionSegment(
  effective: string,
  publishedAt: string,
  known: ScheduleEvent[],
  matchingBoss: (event: ScheduleEvent) => boolean,
) {
  let segment: SoloSegment | undefined;
  let matches: ScheduleEvent[] = [];
  const instants = suspensionInstants(effective, publishedAt);
  const [cutoff] = instants;
  if (instants.size === 1 && cutoff) {
    matches = known.filter(
      (event) =>
        Date.parse(event.startsAt as string) < Date.parse(cutoff) &&
        Date.parse(event.endsAt as string) >= Date.parse(cutoff) &&
        matchingBoss(event),
    );
    const rounds = new Set(matches.map(eventRound));
    const active = matches[0];
    const round = active && eventRound(active);
    if (round && rounds.size === 1 && active?.startsAt)
      segment = {
        round,
        segment: active.segment?.segment ?? 1,
        kind: "suspend",
        effectiveFrom: active.startsAt,
        effectiveUntil: cutoff,
      };
  }
  return { segment, matches };
}

function comparedSegments(event: ScheduleEvent) {
  if (event.segment) return [segmentComparison(event.segment)];
  const round = eventRound(event);
  return round && event.startsAt && event.endsAt
    ? [
        segmentComparison({
          round,
          segment: 1,
          kind: "initial",
          effectiveFrom: event.startsAt,
          effectiveUntil: event.endsAt,
        }),
      ]
    : [];
}

export function judgeInterruption(
  item: NormalizedSourceItem,
  block: { effective: string; evidence: string },
  index: number,
  parseRange: (text: string, published: string) => { start: string; end: string } | null,
  context: SoloContext,
): Judgment | null {
  if (!item.official || !item.structured) return null;
  const reopen = /재\s*오픈|재개/.test(block.effective);
  const suspension = /중단/.test(block.effective);
  if (!reopen && !suspension) return null;
  const known = (context.known ?? []).filter(
    (event) =>
      event.eventType === "solo" &&
      !event.manualReview &&
      event.startsAt &&
      event.endsAt &&
      !(event.sourceItem.source === item.source && event.sourceItem.itemId === item.itemId),
  );
  const boss = (
    /솔로\s*레이드\s*[-–]\s*(.+?)(?:를|\s+재오픈|\n|$)/.exec(block.effective)?.[1] ??
    /랩쳐는\s*「([^」]+)」/.exec(block.effective)?.[1]
  )?.trim();
  const matchingBoss = (event: ScheduleEvent) =>
    !boss || `${event.sourceItem.title}\n${event.sourceItem.normalizedText}`.includes(boss);
  const range = reopen
    ? parseRange(block.effective.replace(/(\d{1,2}:\d{2}):\d{2}/g, "$1"), item.publishedAt)
    : null;
  const { segment, matches } = reopen
    ? reopenSegment(block.effective, known, matchingBoss, range)
    : suspensionSegment(block.effective, item.publishedAt, known, matchingBoss);
  return interruptionJudgment(item, block, index, reopen, known, range, segment, matches);
}

function interruptionJudgment(
  item: NormalizedSourceItem,
  block: { effective: string; evidence: string },
  index: number,
  reopen: boolean,
  known: ScheduleEvent[],
  range: { start: string; end: string } | null,
  segment: SoloSegment | undefined,
  matches: ScheduleEvent[],
): Judgment {
  const reason = segment
    ? null
    : reopen
      ? "reopen_without_suspension"
      : "suspension_without_known_season";
  const event: ScheduleEvent = {
    eventId: `${item.source}:${item.itemId}:solo:${index}`,
    eventType: "solo",
    sourceItem: item,
    startsAt: segment?.effectiveFrom ?? null,
    endsAt: segment?.effectiveUntil ?? null,
    scheduleStatus: "confirmed",
    manualReview: !segment,
    reason,
    ...(segment ? { segment } : {}),
  };
  const overlap =
    reopen && range
      ? known.filter(
          (entry) =>
            Date.parse(entry.startsAt as string) < Date.parse(range.end) &&
            Date.parse(entry.endsAt as string) > Date.parse(range.start),
        )
      : matches;
  const compared = [
    ...new Map([...matches, ...overlap].map((entry) => [entry.eventId, entry])).values(),
  ];
  return {
    blockIndex: index,
    verdict: segment ? "solo" : "manual_review",
    reason,
    question: "중단된 시즌과 재오픈 구간이 동일한 솔로 레이드인지 확인해 주세요.",
    triggers: block.effective
      .split("\n")
      .filter((line) => /중단|재오픈|재개/.test(line))
      .slice(0, 5),
    blockExcerpt: block.evidence.slice(0, 1200),
    maintenanceInputs: [],
    comparison: {
      known: compared[0]
        ? {
            eventId: compared[0].eventId,
            startsAt: compared[0].startsAt,
            endsAt: compared[0].endsAt,
            startKst: null,
            endKst: null,
            segments: compared.flatMap(comparedSegments),
          }
        : null,
      extracted: range
        ? {
            startsAt: range.start,
            endsAt: range.end,
            startKst: `${new Date(Date.parse(range.start) + 9 * 3600000).toISOString().slice(0, 19)}+09:00`,
            endKst: `${new Date(Date.parse(range.end) + 9 * 3600000).toISOString().slice(0, 19)}+09:00`,
          }
        : null,
      equal: false,
      blocking: !segment,
      segments: segment ? [segmentComparison(segment)] : [],
    },
    event,
  };
}

/** Collapse corrections and reopen segments before cadence or overlap analysis. */
export function collapseSoloSegments(events: readonly ScheduleEvent[]) {
  const changes = events.filter((event) => event.segment && !event.manualReview);
  const rounds = new Set(changes.map(eventRound));
  const result = events.filter((event) => !rounds.has(eventRound(event)) || event.manualReview);
  for (const round of rounds) {
    const group = changes.filter((event) => eventRound(event) === round);
    const segments = new Map<number, SoloSegment>();
    for (const event of group) {
      const segment = event.segment as SoloSegment;
      const existing = segments.get(segment.segment);
      if (
        existing &&
        (existing.effectiveFrom !== segment.effectiveFrom ||
          existing.effectiveUntil !== segment.effectiveUntil)
      )
        throw new Error("solo_segment_conflict");
      segments.set(segment.segment, segment);
    }
    const ordered = [...segments.values()].sort((a, b) => a.segment - b.segment);
    if (ordered[0]?.segment !== 1) throw new Error("solo_initial_segment_missing");
    result.push({
      ...(group[0] as ScheduleEvent),
      segment: undefined,
      segments: ordered,
      startsAt: ordered[0].effectiveFrom,
      endsAt: ordered.at(-1)?.effectiveUntil ?? null,
    });
  }
  return result;
}
