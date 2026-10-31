import { noticeEndSeconds } from "./game-day";

export type NoticeDate = {
  date: string;
  instant: string | null;
  maintenance: boolean;
  evidence: string;
};

/**
 * Parses written Korean/slash dates, preserving date-only precision. The notice's
 * KST creation year supplies omitted years; explicit years always win.
 */
export function noticeDates(text: string, postedAt: string, end = false): NoticeDate[] {
  const year = new Date(Date.parse(postedAt) + 9 * 3_600_000).getUTCFullYear();
  if (!Number.isFinite(year)) throw new RangeError("Invalid post time");
  const values: NoticeDate[] = [];
  const pattern =
    /(?:(\d{4})[년/.]\s*)?(\d{1,2})[월/]\s*(\d{1,2})일?(?:\s*\([^)]*\))?\s*(?:(점검\s*완료\s*후)|(\d{1,2}):(\d{2})(?::(\d{2}))?)?/g;
  for (const match of text.matchAll(pattern)) {
    const value = matchedDate(match, year, end);
    if (value) values.push(value);
  }
  return values;
}

function matchedDate(match: RegExpMatchArray, year: number, end: boolean): NoticeDate | null {
  const date = `${match[1] ?? year}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  const dateValue = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(dateValue) || new Date(dateValue).toISOString().slice(0, 10) !== date)
    return null;
  const hour = match[5] ? Number(match[5]) : null;
  const minute = Number(match[6] ?? 0);
  const second = Number(match[7] ?? (end && hour !== null ? noticeEndSeconds(hour, minute) : 0));
  if (hour !== null && (hour > 23 || minute > 59 || second > 59)) return null;
  return {
    date,
    instant:
      hour === null
        ? null
        : `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+09:00`,
    maintenance: Boolean(match[4]),
    evidence: match[0],
  };
}

export type GrantDateCandidate = NoticeDate & {
  basis: "explicit_payment" | "in_post_datetime" | "maintenance_end" | "post_created";
};

/** A8 only: title edits and claim deadlines cannot become grant schedules. */
export function grantDateCandidates(body: string, postedAt: string): GrantDateCandidate[] {
  const { explicit, schedules } = collectGrantDates(body, postedAt);
  const selected = explicit.length ? explicit : schedules;
  if (!selected.length)
    return [
      {
        date: new Date(Date.parse(postedAt) + 9 * 3_600_000).toISOString().slice(0, 10),
        instant: postedAt,
        maintenance: false,
        evidence: postedAt,
        basis: "post_created" as const,
      },
    ];
  return [
    ...new Map(
      selected.map((candidate) => [
        `${candidate.date}:${candidate.instant}:${candidate.maintenance}`,
        candidate,
      ]),
    ).values(),
  ];
}

function dateCandidate(date: NoticeDate, payment: boolean): GrantDateCandidate {
  return {
    ...date,
    basis: payment ? "explicit_payment" : date.maintenance ? "maintenance_end" : "in_post_datetime",
  };
}

function collectGrantDates(body: string, postedAt: string) {
  const lines = body.split("\n");
  const explicit: GrantDateCandidate[] = [];
  const schedules: GrantDateCandidate[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/수령\s*기한|내용\s*(?:추가|수정)/.test(line)) continue;
    const payment = /보상\s*지급일|(?:\d{1,2}[월/]\s*\d{1,2}일?(?:\([^)]*\))?)\s*지급/.test(line);
    const schedule = /중단|연장|재개|점검|진행\s*기간|일시|관리\s*키트/.test(line);
    if (!payment && !schedule) continue;
    // A label may occupy its own line; consume the following line only in that case.
    const own = noticeDates(line.split(/[~～]/)[0] ?? "", postedAt);
    const dates = own.length
      ? own
      : noticeDates((lines[index + 1] ?? "").split(/[~～]/)[0] ?? "", postedAt);
    for (const date of dates) {
      if (!payment && !date.instant && !date.maintenance) continue;
      const candidate = dateCandidate(date, payment);
      (payment ? explicit : schedules).push(candidate);
    }
  }
  return { explicit, schedules };
}
