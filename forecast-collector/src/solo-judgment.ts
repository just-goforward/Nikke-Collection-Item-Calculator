import { noticeTexts, soloSections } from "./solo-sections";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

export const SOLO_RULE_VERSION = "solo-section-v1";
export type SoloReason =
  | "maintenance_missing"
  | "maintenance_conflict"
  | "maintenance_crosses_day"
  | "schedule_conflict"
  | "suspension_unsupported"
  | "reopen_unsupported"
  | "schedule_change_in_section";
export type Judgment = {
  blockIndex: number;
  verdict: "no_change" | "solo" | "schedule_change" | "manual_review" | "ignored";
  reason: string | null;
  question: string;
  triggers: string[];
  blockExcerpt: string;
  maintenanceInputs: string[];
  comparison: {
    known: (ReturnType<typeof times> & { eventId: string }) | null;
    extracted: ReturnType<typeof times> | null;
    equal: boolean;
  };
  event?: ScheduleEvent;
};
export const judgments = new WeakMap<NormalizedSourceItem, Judgment[]>();
export type SoloContext = {
  known?: readonly ScheduleEvent[];
  maintenance?: readonly { text: string; publishedAt: string }[];
};

function times(start: string | null, end: string | null) {
  const kst = (value: string | null) =>
    value ? `${new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 19)}+09:00` : null;
  return { startsAt: start, endsAt: end, startKst: kst(start), endKst: kst(end) };
}
export function soloLookup(item: NormalizedSourceItem) {
  const text = noticeTexts.get(item) ?? {
    effective: item.normalizedText,
    evidence: item.normalizedText,
  };
  const sections = soloSections(text);
  const blocks = sections.length ? sections : [text];
  const solo = sections.length > 0 || /(솔로\s*레이드|솔레)/.test(text.effective);
  const dates =
    solo && !/점검\s*일시/.test(text.effective)
      ? blocks.flatMap((block) => {
          const match = block.effective.match(
            /(?:(\d{4})년\s*)?(\d{1,2})[월/]\s*(\d{1,2})일?(?:\([^)]*\))?[^~\n]*점검\s*완료\s*후/,
          );
          return match
            ? [
                `${match[1] ?? new Date(item.publishedAt).getUTCFullYear()}-${match[2]?.padStart(2, "0")}-${match[3]?.padStart(2, "0")}`,
              ]
            : [];
        })
      : [];
  return { solo, dates: [...new Set(dates)] };
}
export function startGameDate(value: string) {
  return new Date(Date.parse(value) + 4 * 3600000).toISOString().slice(0, 10);
}
export function equivalentEnd(left: string, right: string) {
  const canonical = (value: string) => {
    const instant = Date.parse(value);
    const local = new Date(instant + 9 * 3600000);
    return local.getUTCHours() === 4 && local.getUTCMinutes() === 59
      ? Math.floor(instant / 60000) * 60000
      : instant;
  };
  return canonical(left) === canonical(right);
}

export function judgeSolo(
  item: NormalizedSourceItem,
  parseRange: (text: string, published: string) => { start: string; end: string } | null,
  context: SoloContext = {},
): Judgment[] | null {
  const text = noticeTexts.get(item) ?? {
    effective: item.normalizedText,
    evidence: item.normalizedText,
  };
  const sections = soloSections(text);
  if (!sections.length && !/(솔로\s*레이드|솔레)/.test(text.effective)) return null;
  const numbered = sections.length > 0;
  const blocks = numbered ? sections : [text];
  return blocks.map((block, index) => {
    const period = numbered
      ? (block.effective
          .split("\n")
          .find((line) => /(?:이벤트\s*)?진행\s*기간\s*[:：-]/.test(line)) ?? "")
      : block.effective;
    const changedText = numbered
      ? block.effective
      : block.effective
          .split(/[.!?。！？\n]/)
          .filter((sentence) => /(솔로\s*레이드|솔레)/.test(sentence))
          .join("\n");
    let reason: string | null = !item.official
      ? "not_official_manager"
      : !item.structured
        ? "unstructured_body"
        : /중단/.test(changedText)
          ? "suspension_unsupported"
          : /재오픈|재개/.test(changedText)
            ? "reopen_unsupported"
            : /연장|일정\s*변경/.test(changedText) || (!numbered && /종료/.test(changedText))
              ? "schedule_change_in_section"
              : null;
    let schedule = parseRange(
      period.replace(/점검\s*완료\s*후/g, "").replace(/(\d{1,2}:\d{2}):\d{2}/g, "$1"),
      item.publishedAt,
    );
    const triggers = block.effective
      .split("\n")
      .filter((line) => /솔로|기간|중단|연장|재개|재오픈|일정\s*변경/.test(line));
    let unresolvedStart: string | null = null;
    const maintenanceInputs: string[] = [];
    if (/점검\s*완료\s*후/.test(period)) {
      const classificationReason = reason;
      reason = null;
      const date = period.match(/(?:(\d{4})년\s*)?(\d{1,2})[월/]\s*(\d{1,2})일?/);
      const year = Number(date?.[1] ?? new Date(item.publishedAt).getUTCFullYear());
      const month = Number(date?.[2]);
      const day = Number(date?.[3]);
      const maintenance = (input: string, publishedAt: string) =>
        [
          ...input.matchAll(
            /점검\s*일시\s*[-:：]\s*(\d{1,2})월\s*(\d{1,2})일\s*\([^)]*\)\s*(\d{1,2}):(\d{2}):(\d{2})\s*[~～]\s*(\d{1,2}):(\d{2}):(\d{2})/g,
          ),
        ].filter(
          (match) =>
            new Date(publishedAt).getUTCFullYear() === year &&
            Number(match[1]) === month &&
            Number(match[2]) === day,
        );
      const local = maintenance(text.effective, item.publishedAt);
      const matches = /점검\s*일시/.test(text.effective)
        ? local
        : (context.maintenance ?? []).flatMap((row) => maintenance(row.text, row.publishedAt));
      maintenanceInputs.push(...matches.map((match) => `${year}:${match[0]}`).sort());
      const ends = new Set(
        matches.map((match) => {
          const start = Number(match[3]) * 3600 + Number(match[4]) * 60 + Number(match[5]);
          let end = Number(match[6]) * 3600 + Number(match[7]) * 60 + Number(match[8]);
          if (end < start) end += 86400;
          return end;
        }),
      );
      triggers.push(...matches.map((match) => match[0]));
      const [end] = ends;
      if (!date || end === undefined) reason = "maintenance_missing";
      else if (ends.size > 1) reason = "maintenance_conflict";
      else if (end >= 86400 + 5 * 3600) reason = "maintenance_crosses_day";
      else if (schedule)
        schedule = {
          ...schedule,
          start: new Date(Date.UTC(year, month - 1, day, -9, 0, end)).toISOString(),
        };
      if (reason)
        unresolvedStart = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} 점검 완료 후(시각 미확정)`;
      reason = classificationReason ?? reason;
    }
    if (!schedule && !reason) reason = "ambiguous_schedule_change";
    const known = schedule
      ? (context.known ?? []).filter(
          (event) =>
            !(event.sourceItem.source === item.source && event.sourceItem.itemId === item.itemId) &&
            event.eventType === "solo" &&
            event.scheduleStatus === "confirmed" &&
            !event.manualReview &&
            event.startsAt &&
            event.endsAt &&
            (startGameDate(event.startsAt) === startGameDate(schedule.start) ||
              (Date.parse(event.startsAt) < Date.parse(schedule.end) &&
                Date.parse(schedule.start) < Date.parse(event.endsAt))),
        )
      : [];
    const equal =
      schedule && known.length
        ? known.every(
            (event) =>
              startGameDate(event.startsAt as string) === startGameDate(schedule.start) &&
              equivalentEnd(event.endsAt as string, schedule.end),
          )
        : null;
    if (!reason && equal === false) reason = "schedule_conflict";
    const event: ScheduleEvent = {
      eventId: `${item.source}:${item.itemId}:${reason ? "schedule_change" : "solo"}${index > 0 ? `:${index}` : ""}`,
      eventType:
        reason && /unsupported|schedule_change_in_section/.test(reason)
          ? "schedule_change"
          : "solo",
      sourceItem: item,
      startsAt: unresolvedStart ? null : (schedule?.start ?? null),
      endsAt: schedule?.end ?? null,
      scheduleStatus: "confirmed",
      manualReview: reason !== null,
      reason,
    };
    return {
      blockIndex: index,
      verdict: reason ? "manual_review" : equal ? "no_change" : "solo",
      reason,
      question:
        "이 솔로 레이드 구간의 시작일과 종료 시각이 확정된 일정과 일치하는지 확인했으며, 오류가 있으면 변경 공지와 점검 종료 시각을 확인해 주세요.",
      triggers: triggers.slice(0, 5).map((line) => line.slice(0, 200)),
      blockExcerpt: block.evidence.slice(0, 1200),
      maintenanceInputs,
      comparison: {
        known: known[0]
          ? { eventId: known[0].eventId, ...times(known[0].startsAt, known[0].endsAt) }
          : null,
        extracted: {
          ...times(event.startsAt, event.endsAt),
          ...(unresolvedStart ? { startKst: unresolvedStart } : {}),
        },
        equal: equal === true && !unresolvedStart,
      },
      ...(equal && !reason ? {} : { event }),
    };
  });
}
