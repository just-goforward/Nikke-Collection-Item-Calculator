import { extractNoticeText } from "../../solo-sections";
import { type ExistingWindow, resolveMaintenance } from "./identity";
import { type NoticeDate, noticeDates } from "./notice-dates";

export type ScheduleJudgment =
  | { action: "ignore" }
  | {
      action: "decision";
      reason: string;
      /** Partial parse kept as evidence; a decision is still required. */
      startAt?: string;
      endAt?: string;
    }
  | { action: "confirmed"; startAt: string; endAt: string; maintenanceEventId?: string };
export type Notice = { title: string; body: string; postedAt: string };

/** Input is one current version, with obsolete struck-out text removed. */
export function judgeMaintenance(post: Notice): ScheduleJudgment {
  const text = extractNoticeText(post.body).effective;
  const lines = text.split("\n");
  const isTimeLabel = (line: string) =>
    /^[^\p{L}\p{N}]*(?:점검\s*)?일시(?:\s*[:：-]|\s|$)/u.test(line);
  if (!/점검/.test(post.title.replace(/무점검/g, "")) || !lines.some(isTimeLabel))
    return { action: "ignore" };
  const ranges: { startAt: string; endAt: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTimeLabel(lines[i]!) && !/점검\s*연장/.test(lines[i]!)) continue;
    const input = `${lines[i]}\n${lines[i + 1] ?? ""}`;
    const dates = noticeDates(input, post.postedAt);
    const start = dates[0];
    if (!start?.instant) continue;
    const rangeEnd =
      /[~～]\s*(?:(\d{1,2})[월/]\s*(\d{1,2})일?(?:\s*\([^)]*\))?\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(
        input,
      );
    if (!rangeEnd) continue;
    const date = rangeEnd[1]
      ? `${start.date.slice(0, 4)}-${rangeEnd[1].padStart(2, "0")}-${rangeEnd[2]!.padStart(2, "0")}`
      : start.date;
    const endAt = `${date}T${rangeEnd[3]!.padStart(2, "0")}:${rangeEnd[4]}:${rangeEnd[5] ?? "00"}+09:00`;
    if (Date.parse(endAt) > Date.parse(start.instant))
      ranges.push({ startAt: start.instant, endAt });
  }
  if (!ranges.length) return { action: "decision", reason: "maintenance_period_missing" };
  // Multiple ranges within one revised notice represent extension evidence.
  const startAt = ranges.reduce((a, b) =>
    Date.parse(a.startAt) < Date.parse(b.startAt) ? a : b,
  ).startAt;
  const endAt = ranges.reduce((a, b) => (Date.parse(a.endAt) > Date.parse(b.endAt) ? a : b)).endAt;
  return { action: "confirmed", startAt, endAt };
}

/**
 * The period block a solo notice states: the "진행 기간" line plus its continuation,
 * with any "(내용 추가/수정)" editorial note removed.
 */
function soloPeriod(text: string) {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => /진행\s*기간/.test(line));
  const period = (index < 0 ? text : `${lines[index]}\n${lines[index + 1] ?? ""}`).replace(
    /\([^)]*내용\s*(?:추가|수정)[^)]*\)/g,
    "",
  );
  return period;
}

/** A "점검 완료 후" start either resolves to a maintenance end or names a reason. */
function soloStart(dates: NoticeDate[], maintenance: readonly ExistingWindow[]) {
  const first = dates[0];
  if (!first?.maintenance) return { startAt: first?.instant ?? null };
  const match = resolveMaintenance(first.date, maintenance);
  return "reason" in match
    ? { startAt: null, unresolvedMaintenance: match.reason }
    : { startAt: match.endAt, maintenanceEventId: match.eventId };
}

/** "오픈 안내 … 까지" states an end only; the post time is then the start. */
function openNoticeSpan(
  post: Notice,
  period: string,
  dates: NoticeDate[],
  ends: NoticeDate[],
): { startAt: string; endAt: string | undefined } | null {
  if (dates.length !== 1 || !/오픈\s*안내/.test(post.title) || !/까지/.test(period)) return null;
  return { startAt: post.postedAt, endAt: ends[0]?.instant ?? undefined };
}

/** The span a solo notice states, keeping a known start when the end is unusable. */
function soloSpan(startAt: string | null, endAt: string | null | undefined) {
  const usableEnd = endAt && (!startAt || Date.parse(endAt) > Date.parse(startAt)) ? endAt : null;
  return {
    ordered: Boolean(startAt && usableEnd && Date.parse(usableEnd) > Date.parse(startAt)),
    usableEnd,
  };
}

export function judgeSolo(post: Notice, maintenance: readonly ExistingWindow[]): ScheduleJudgment {
  const text = extractNoticeText(post.body).effective;
  if (!/솔로\s*레이드/.test(`${post.title}\n${text}`)) return { action: "ignore" };
  const period = soloPeriod(text);
  const dates = noticeDates(period, post.postedAt);
  const start = soloStart(dates, maintenance);
  const ends = noticeDates(period, post.postedAt, true);
  const defaultEnd = ends.length > 1 ? (ends.at(-1)?.instant ?? null) : null;
  const open = openNoticeSpan(post, period, dates, ends);
  const startAt = open?.startAt ?? start.startAt;
  const endAt = open ? open.endAt : defaultEnd;
  if ("unresolvedMaintenance" in start && start.unresolvedMaintenance)
    return {
      action: "decision",
      reason: start.unresolvedMaintenance,
      ...(endAt ? { endAt } : {}),
    };
  const span = soloSpan(startAt, endAt);
  if (!span.ordered)
    return {
      action: "decision",
      reason: "solo_period_unresolved",
      ...(startAt ? { startAt } : {}),
      ...(span.usableEnd ? { endAt: span.usableEnd } : {}),
    };
  return {
    action: "confirmed",
    startAt: startAt as string,
    endAt: span.usableEnd as string,
    ...("maintenanceEventId" in start && start.maintenanceEventId
      ? { maintenanceEventId: start.maintenanceEventId }
      : {}),
  };
}

export type InterruptionSegment = {
  kind: "suspend" | "resume" | "extend" | "reopen" | "close";
  startAt?: string;
  endAt?: string;
};
/** B extraction is evidence only; callers must always request admin confirmation. */
export function interruptionEvidence(
  post: Notice,
  maintenance: readonly ExistingWindow[] = [],
): InterruptionSegment[] {
  const text = extractNoticeText(post.body).effective.replace(
    /\([^)]*내용\s*(?:추가|수정)[^)]*\)/g,
    "",
  );
  const segments: InterruptionSegment[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const kind = interruptionKind(line);
    if (!kind) continue;
    const input = interruptionInput(lines, index, post.postedAt, kind);
    const segment = interruptionSegment(input, kind, post.postedAt, maintenance);
    if (segment) segments.push(segment);
  }
  return [...new Map(segments.map((segment) => [JSON.stringify(segment), segment])).values()];
}

function interruptionKind(line: string): InterruptionSegment["kind"] | null {
  if (/중단/.test(line)) return "suspend";
  if (/재오픈/.test(line)) return "reopen";
  if (/재개/.test(line)) return "resume";
  if (/연장/.test(line)) return "extend";
  if (/종료/.test(line)) return "close";
  return null;
}

function interruptionInput(
  lines: string[],
  index: number,
  postedAt: string,
  kind: InterruptionSegment["kind"],
) {
  const line = lines[index]!;
  let input = noticeDates(line, postedAt).length ? line : `${line}\n${lines[index + 1] ?? ""}`;
  if (
    (kind === "reopen" || kind === "resume") &&
    !noticeDates(input, postedAt).some((date) => date.instant || date.maintenance)
  ) {
    for (let following = index + 1; following < lines.length; following++) {
      const next = lines[following]!;
      if (/^\d+\.\s|^[·─\s]+$/.test(next)) break;
      if (/진행\s*기간/.test(next)) {
        input = `${next}\n${lines[following + 1] ?? ""}`;
        break;
      }
    }
  }
  return input;
}

function interruptionSegment(
  input: string,
  kind: InterruptionSegment["kind"],
  postedAt: string,
  maintenance: readonly ExistingWindow[],
): InterruptionSegment | null {
  const dates = noticeDates(input, postedAt);
  let startAt = dates[0]?.instant;
  if (dates[0]?.maintenance) {
    const resolved = resolveMaintenance(dates[0].date, maintenance);
    if ("endAt" in resolved) startAt = resolved.endAt;
  }
  const endAt =
    dates.length > 1 || kind === "extend"
      ? noticeDates(input, postedAt, true).at(-1)?.instant
      : null;
  if (!startAt && !endAt) return null;
  return {
    kind,
    ...(startAt && !(kind === "extend" && dates.length === 1) ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
  };
}
