import type {
  ActiveRow,
  PublicationAction,
  ReviewRow,
} from "../../shared/forecast-publication/store.ts";
import { canonicalPublicationJson } from "../../shared/forecastPublication.ts";
import { gameDayKey, gameDayStartCeilMs, gameDayStartMs } from "../../shared/gameDay.ts";
import { kst, kstLabel } from "../../shared/kst.ts";
import type { SupplyForecastCandidate } from "../../shared/supplyForecastCandidate.ts";

/** Discord rejects content above 2000 characters, so the layout is budgeted, not sliced. */
const CONTENT_LIMIT = 2000;
const MAX_SOURCES = 3;
/** A few concrete lines, then a count: an approval request is a summary, not a report. */
const MAX_ROUND_LINES = 4;
const MAX_RULE_LINES = 2;
const REWARD_LABEL_LIMIT = 160;

/** Law identifiers as operators see them. An unlisted identifier is shown verbatim. */
const LAW_KO: Readonly<Record<string, { label: string; unit: string }>> = {
  "regular-box-v1": { label: "일반 상자", unit: "개" },
  "box-ii-v1": { label: "상자 II", unit: "개" },
  "dispatch-board-v1": { label: "파견 보상", unit: "회" },
  "deterministic:10,10,0": { label: "고정 구성(10·10·0)", unit: "개" },
};

/**
 * Operator-facing Korean labels. Nothing parses a button label: interactions route on the
 * `forecast_publish:<env>:<review_id>` custom_id and read severity from `forecast_runtime_reviews`.
 */
const ACTION_LABEL: Record<PublicationAction, string> = {
  approve: "승인",
  rollback: "롤백",
  off: "끄기",
};

/** Body-text action names: plain words, never the button's parenthesized style. */
const ACTION_KO: Record<PublicationAction, string> = {
  approve: "승인",
  rollback: "되돌리기",
  off: "끄기",
};

const TITLE: Record<PublicationAction, string> = {
  approve: "Forecast 예보 반영 승인 요청",
  rollback: "Forecast 이전 후보로 되돌리기 확인",
  off: "Forecast 예보 끄기 확인",
};

const WHAT: Record<PublicationAction, string> = {
  approve:
    "이 예보 후보를 {env} 사이트에 반영해도 되는지 승인을 요청하는 메시지입니다. 아직 사이트 내용은 바뀌지 않았습니다.",
  rollback:
    "지금 반영된 예보를 이전에 승인한 후보로 되돌릴지 확인하는 메시지입니다. 아직 아무것도 바뀌지 않았습니다.",
  off: "예보 반영을 끌지 확인하는 메시지입니다. 아직 아무것도 바뀌지 않았습니다.",
};

const CHANGES: Record<PublicationAction, string> = {
  approve: "사이트의 예보가 이 후보 내용으로 바뀝니다.",
  rollback: "사이트의 예보가 이전 승인본 내용으로 돌아갑니다.",
  off: "사이트에서 예보가 내려가고 끄기 상태가 됩니다.",
};

const TODO: Record<PublicationAction, string> = {
  approve:
    "👉 해 주실 일: 아래 내용이 맞는지 확인한 뒤 버튼을 한 번만 눌러 주세요. 반영이 필요 없으면 그대로 두시면 됩니다.",
  rollback:
    "👉 해 주실 일: 되돌릴 대상이 맞는지 확인한 뒤 버튼을 눌러 주세요. 그대로 두면 아무것도 바뀌지 않습니다.",
  off: "👉 해 주실 일: 예보를 멈출 필요가 있을 때만 버튼을 눌러 주세요. 그대로 두면 아무것도 바뀌지 않습니다.",
};

/** Known candidate warnings, translated. An unknown warning is shown verbatim, never guessed. */
const WARNING_KO: Readonly<Record<string, string>> = {
  "Some Solo Raid reference windows use cadence estimates.":
    "일부 솔로 레이드 기준 구간은 주기 추정치를 사용했습니다.",
  "New-round cadence could not be derived from the available history.":
    "가능한 기록만으로는 새 라운드 주기를 계산하지 못했습니다.",
  "X is advisory and is evaluated during proposal review.":
    "X(트위터) 정보는 참고용이며 제안 검토 단계에서 함께 평가됩니다.",
  "Official sources report conflicting schedules.": "공식 출처 간 일정이 서로 다릅니다.",
};

type NoticePeriod = { start: number; end: number };

/** Preserve the notice instants and the lower-resolution ledger separately. */
type ReviewRound = {
  round: number;
  status: "confirmed" | "estimated" | "unverified";
  startGameDate: string;
  endGameDate: string | null;
  periods: NoticePeriod[];
};

export type ReviewCandidateView = SupplyForecastCandidate;

type ReviewSibling = {
  action: PublicationAction;
  createdAt: number;
  /** `null` when the sibling has no candidate (an `off` review). */
  candidateId: string | null;
};

type ReviewCompetition = {
  counts: Record<PublicationAction, number>;
  todayCount: number;
  newer: ReviewSibling | null;
};

type ReviewMessageInput = {
  review: ReviewRow & { created_at: number };
  active: ActiveRow;
  /** The sealed candidate under review; `null` for an `off` review. */
  candidate: ReviewCandidateView | null;
  /** The candidate the site shows right now; `null` when active is off. */
  activeCandidate: ReviewCandidateView | null;
  competition: ReviewCompetition;
  now: number;
};

/** Korean button label; the custom_id (the only parsed field) is unchanged. */
export function publicationButtonLabel(action: PublicationAction, environment: string) {
  return `${ACTION_LABEL[action]} (${environment})`;
}

export function translateCandidateWarning(warning: string) {
  return WARNING_KO[warning] ?? oneLine(warning, 300);
}

/** Pending reviews that compete for the same expected sequence. */
export async function loadReviewCompetition(
  db: D1Database,
  review: ReviewRow,
  now: number,
): Promise<ReviewCompetition> {
  const rows = await db
    .prepare(`SELECT r.action,COUNT(*) AS n,
      SUM(CASE WHEN json_extract(c.payload_json,'$.certifiedSnapshot.coverage.currentDay')=?
        THEN 1 ELSE 0 END) AS today
    FROM forecast_runtime_reviews r LEFT JOIN forecast_candidates c ON c.candidate_id=r.candidate_id
    WHERE r.environment=? AND r.expected_sequence=? AND r.expires_at>?
      AND NOT EXISTS(SELECT 1 FROM forecast_runtime_activation_history h WHERE h.review_id=r.review_id)
    GROUP BY r.action`)
    .bind(gameDayKey(now), review.environment, review.expected_sequence, now)
    .all<{ action: PublicationAction; n: number; today: number }>();
  const newest = await db
    .prepare(`SELECT r.action,r.candidate_id,r.created_at FROM forecast_runtime_reviews r
    WHERE r.environment=? AND r.expected_sequence=? AND r.expires_at>?
      AND r.created_at>(SELECT created_at FROM forecast_runtime_reviews WHERE review_id=?)
      AND NOT EXISTS(SELECT 1 FROM forecast_runtime_activation_history h WHERE h.review_id=r.review_id)
    ORDER BY r.created_at DESC,r.review_id ASC LIMIT 1`)
    .bind(review.environment, review.expected_sequence, now, review.review_id)
    .first<{ action: PublicationAction; candidate_id: string | null; created_at: number }>();
  const counts = { approve: 0, rollback: 0, off: 0 };
  let todayCount = 0;
  for (const row of rows.results) {
    counts[row.action] = row.n;
    todayCount += row.today;
  }
  return {
    counts,
    todayCount,
    newer: newest
      ? { action: newest.action, createdAt: newest.created_at, candidateId: newest.candidate_id }
      : null,
  };
}

export function publicationReviewPayload(input: ReviewMessageInput) {
  return {
    content: publicationReviewContent(input),
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: input.review.action === "approve" ? 3 : 4,
            label: publicationButtonLabel(input.review.action, input.review.environment),
            custom_id: `forecast_publish:${input.review.environment}:${input.review.review_id}`,
          },
        ],
      },
    ],
  };
}

export function publicationReviewContent(input: ReviewMessageInput) {
  const { review } = input;
  const essential = [
    `**${TITLE[review.action]}** · 환경: ${review.environment}`,
    `📝 무슨 일이: ${WHAT[review.action].replace("{env}", review.environment)}`,
    changesBlock(input),
    `🕔 그대로 두면: ${kstLabel(new Date(review.expires_at).toISOString())} KST에 만료되고, 만료되면 아무것도 바뀌지 않습니다.`,
    TODO[review.action],
  ];
  const optional = [
    siblingBlock(review, input.competition, input.now),
    activeBlock(input.active, input.activeCandidate),
    sourceBlock(input.candidate),
    warningBlock(input.candidate),
  ].filter((block): block is string => block !== null);
  return assemble(essential, optional, ledger(review));
}

/**
 * A factual comparison against the candidate the site shows now. Every line comes from
 * the two sealed payloads: solo-raid rounds by number and game date, then rules and grants
 * only when their contents differ. Nothing is inferred, and long lists are summarized.
 */
function changesBlock({ review, active, candidate, activeCandidate, now }: ReviewMessageInput) {
  const coverageDay = candidate?.certifiedSnapshot?.coverage.currentDay;
  if (review.action !== "approve") {
    const lines = [`📌 반영하면 바뀌는 것: ${CHANGES[review.action]}`];
    if (coverageDay) lines.push(coverageNote(coverageDay, now));
    return lines.join("\n");
  }
  if (!candidate) return "📌 반영하면 바뀌는 것: 확인할 후보 내용이 없습니다.";
  const heading = `📌 반영하면 바뀌는 것${coverageDay ? ` (기준 게임일 ${coverageDay}${coverageLabel(coverageDay, now)})` : ""}:`;
  if (!active.candidate_id)
    return [
      heading,
      "· 지금은 예보가 끄기 상태입니다. 승인하면 아래 후보 내용이 표시됩니다.",
      ...detailLines(candidate),
    ].join("\n");
  if (!activeCandidate)
    return [
      heading,
      "· 현재 반영본을 읽을 수 없어 비교할 수 없습니다.",
      ...detailLines(candidate),
    ].join("\n");

  const { roundLines, unchanged } = roundDiff(activeCandidate, candidate);
  const shown = roundLines.slice(0, MAX_ROUND_LINES);
  const lines = [heading, ...(shown.length ? shown : ["· 솔로 레이드 일정은 지금과 같습니다."])];
  if (roundLines.length > shown.length)
    lines.push(`· 그 외 ${roundLines.length - shown.length}건 일정 변경`);
  const { changes, windowShifted } = ruleDiffLines(activeCandidate, candidate);
  lines.push(...unchangedLine(unchanged, changes.length === 0));
  lines.push(...changes.slice(0, MAX_RULE_LINES).map(({ line }) => oneLine(line, 260)));
  const remaining = changes.slice(MAX_RULE_LINES);
  if (remaining.length)
    lines.push(`· 외 ${remaining.length}건: ${remaining.map(({ kind }) => kind).join(" · ")}`);
  if (windowShifted) lines.push("· 적용 기간 시작일만 기준 게임일에 맞춰 이동");
  return lines.join("\n");
}

/** One line per round that differs, plus the numbers that are unchanged. */
function roundDiff(before: ReviewCandidateView, after: ReviewCandidateView) {
  const previous = roundsByNumber(before);
  const next = roundsByNumber(after);
  const roundLines: string[] = [];
  const unchanged: number[] = [];
  for (const round of [...new Set([...previous.keys(), ...next.keys()])].sort((a, b) => a - b)) {
    const old = previous.get(round);
    const current = next.get(round);
    const historyOnly =
      old?.status === "confirmed" &&
      current?.status === "confirmed" &&
      old.startGameDate === current.startGameDate &&
      old.endGameDate !== null &&
      current.endGameDate === null &&
      current.periods.length === 0 &&
      outsideWindow(old, after) &&
      outsideWindow(current, after);
    const line = historyOnly ? null : roundLine(round, old, current);
    if (line === null) unchanged.push(round);
    else roundLines.push(line);
  }
  return { roundLines, unchanged };
}

function roundLine(round: number, before: ReviewRound | undefined, after: ReviewRound | undefined) {
  if (!before && after)
    return `· 라운드 ${round} 추가: ${roundRange(after)} (${statusKo(after.status)})`;
  if (before && !after) return `· 라운드 ${round} 제외: 기존 ${roundRange(before)}`;
  if (!before || !after) return null;
  return sameRound(before, after)
    ? null
    : `· 라운드 ${round} 변경: ${roundRange(before)} (${statusKo(before.status)}) → ${roundRange(after)} (${statusKo(after.status)})`;
}

/** The unchanged rounds and rule blocks, in one line; empty when nothing is unchanged. */
function unchangedLine(unchanged: number[], rulesSame: boolean) {
  if (unchanged.length)
    return [
      `· 변경 없음: 라운드 ${summarizeNumbers(unchanged)}${rulesSame ? ", 지급·상점·주간 키트·파견·보상 구성 동일" : ""}`,
    ];
  return rulesSame ? ["· 변경 없음: 지급·상점·주간 키트·파견·보상 구성 동일"] : [];
}

function coverageNote(coverageDay: string, now: number) {
  return `· 기준 게임일: ${coverageDay}${coverageLabel(coverageDay, now)}`;
}

function coverageLabel(coverageDay: string, now: number) {
  const today = gameDayKey(now);
  if (coverageDay === today) return " · 현재 게임일";
  if (coverageDay < today) return " · 지난 게임일 기준";
  return " · 미래 게임일 기준";
}

function roundsByNumber(candidate: ReviewCandidateView) {
  const rounds = new Map<number, ReviewRound>();
  for (const round of candidate.certifiedSnapshot?.soloRounds ?? []) {
    rounds.set(round.round, {
      round: round.round,
      status: round.status,
      startGameDate: round.startGameDate,
      endGameDate: round.endGameDate,
      periods: sealedPeriods(candidate, round.round),
    });
  }
  // Legacy periods can carry explicit identities, never fabricate a round by array index.
  if (!candidate.certifiedSnapshot)
    candidate.schedule.soloPeriods.forEach((period) => {
      if (period.round === undefined || rounds.has(period.round)) return;
      const periods = sealedPeriods(candidate, period.round);
      rounds.set(period.round, {
        round: period.round,
        status: period.scheduleStatus,
        ...noticeGameDays(periods),
        periods,
      });
    });
  return rounds;
}

function sameRound(left: ReviewRound, right: ReviewRound) {
  // Snapshot ledger dates include reward caps; do not derive them again from a
  // notice that may remain open beyond the reward window.
  if (
    left.status !== right.status ||
    left.startGameDate !== right.startGameDate ||
    left.endGameDate !== right.endGameDate
  )
    return false;
  // Notice-minute precision is an additional comparison only when both sides have it.
  if (left.periods.length && right.periods.length) {
    return (
      left.periods.length === right.periods.length &&
      left.periods.every((period, index) => {
        const other = right.periods[index];
        return (
          other !== undefined &&
          Math.floor(period.start / 60_000) === Math.floor(other.start / 60_000) &&
          lastNoticeMinute(period.end) === lastNoticeMinute(other.end)
        );
      })
    );
  }
  return true;
}

function sealedPeriods(candidate: ReviewCandidateView, round: number): NoticePeriod[] {
  return candidate.schedule.soloPeriods
    .filter((period) => period.round === round)
    .map((period) => ({
      start: Date.parse(period.effectiveFrom),
      end: Date.parse(period.effectiveUntil),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function noticeGameDays(periods: NoticePeriod[]) {
  return {
    startGameDate: gameDayKey(Math.min(...periods.map((period) => period.start))),
    endGameDate: gameDayKey(gameDayStartCeilMs(Math.max(...periods.map((period) => period.end)))),
  };
}

/** 04:59:59 and an exclusive 05:00 boundary both end in the 04:59 notice minute. */
function lastNoticeMinute(end: number) {
  return Math.floor((end - 1) / 60_000) * 60_000;
}

/**
 * readCandidateHeads keeps the latest confirmed anchor plus overlapping periods.
 * Earlier starts remain in cadence history without durations; confirmedLedgerRound
 * emits null ends when that period association is absent. Do not infer this for an
 * in-window round, a changed start/status, or a round without a later confirmed anchor.
 */
function outsideWindow(round: ReviewRound, candidate: ReviewCandidateView) {
  const snapshot = candidate.certifiedSnapshot;
  if (!snapshot) return false;
  const from = Date.parse(snapshot.coverage.from);
  if (round.endGameDate) return Date.parse(`${round.endGameDate}T05:00:00+09:00`) <= from;
  return (
    Date.parse(`${round.startGameDate}T05:00:00+09:00`) < from &&
    !candidate.schedule.soloPeriods.some(
      (period) =>
        period.round === round.round ||
        gameDayKey(Date.parse(period.effectiveFrom)) === round.startGameDate,
    ) &&
    candidate.schedule.soloPeriods.some(
      (period) =>
        period.scheduleStatus === "confirmed" &&
        period.round !== undefined &&
        period.round > round.round,
    )
  );
}

/** Prefer notice times; explicitly label lower-resolution game-day fallbacks. */
function roundRange(round: ReviewRound) {
  if (round.periods.length)
    return round.periods
      .map((period) => displayedPeriod(period.start, lastNoticeMinute(period.end)))
      .join(" / ");
  const start = gameDayStartMs(Date.parse(round.startGameDate));
  if (round.endGameDate === null)
    return `게임일 ${periodTime(start)} KST 시작 · 종료일 정보 없음(확인 필요)`;
  return `게임일 ${periodRange(start, gameDayStartMs(Date.parse(round.endGameDate)))}`;
}

/** Reuse the shared KST formatter, omitting weekdays only for compact period ranges. */
function periodTime(at: number, includeYear = false) {
  return kst(at, includeYear).replace(/\([일월화수목금토]\)/, "");
}

function periodRange(start: number, exclusiveEnd: number | null) {
  return displayedPeriod(start, exclusiveEnd === null ? null : exclusiveEnd - 60_000);
}

function displayedPeriod(start: number, lastMinute: number | null) {
  if (lastMinute === null) return `${periodTime(start)} KST부터`;
  const yearChanged = kst(start, true).slice(0, 4) !== kst(lastMinute, true).slice(0, 4);
  return `${periodTime(start)}~${periodTime(lastMinute, yearChanged)} KST`;
}

function statusKo(status: ReviewRound["status"]) {
  return status === "confirmed" ? "확정" : status === "estimated" ? "추정" : "미확인";
}

type Refs = readonly { lawId: string; count: number }[];
const RULE_PARTS = [
  // certifiedSupplyBuild:recurringEvents emits the dispatch allowance every game day and the
  // shop allowance once each Tuesday.
  ["파견(일당)", "dispatch"],
  ["상점(주당)", "normalShop"],
  ["콜라보 상점(주당)", "collaborationShop"],
  ["주간 키트", "weeklyFixed"],
] as const;

function normalizedRefs(refs: Refs) {
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(ref.lawId, (counts.get(ref.lawId) ?? 0) + ref.count);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

function rollingWindowShift(before: ReviewCandidateView, after: ReviewCandidateView) {
  const left = before.certifiedSnapshot?.coverage;
  const right = after.certifiedSnapshot?.coverage;
  if (!left || !right) return false;
  const delta = Date.parse(right.from) - Date.parse(left.from);
  return (
    delta !== 0 &&
    delta === Date.parse(right.currentDay) - Date.parse(left.currentDay) &&
    left.past.days === right.past.days
  );
}

function rulePart(
  candidate: ReviewCandidateView,
  key: (typeof RULE_PARTS)[number][1],
  rolling: boolean,
) {
  const windowStart = Date.parse(candidate.certifiedSnapshot?.coverage.from ?? "");
  return [...(candidate.certifiedSnapshot?.rules ?? [])]
    .sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom))
    .map((rule) => ({
      from:
        rolling && Date.parse(rule.effectiveFrom) === windowStart
          ? "coverage-start"
          : Date.parse(rule.effectiveFrom),
      until: rule.effectiveUntil ? Date.parse(rule.effectiveUntil) : null,
      refs: normalizedRefs(rule[key] ?? []),
    }));
}

function grantKey(candidate: ReviewCandidateView) {
  return (candidate.grants ?? [])
    .map((grant) => ({
      id: grant.id,
      date: grant.grantGameDate,
      until: grant.claimUntil ? Date.parse(grant.claimUntil) : null,
      assumed: grant.claimWindowAssumed,
      restatement: [...grant.restatementOf].sort(),
      refs: normalizedRefs(grant.refs),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function rulePartChange(
  before: ReviewCandidateView,
  after: ReviewCandidateView,
  label: string,
  key: (typeof RULE_PARTS)[number][1],
  rolling: boolean,
) {
  const left = rulePart(before, key, rolling),
    right = rulePart(after, key, rolling);
  if (canonicalPublicationJson(left) === canonicalPublicationJson(right)) return null;
  const from = before.certifiedSnapshot?.rules ?? [],
    to = after.certifiedSnapshot?.rules ?? [];
  const datesChanged = left[0]?.from !== right[0]?.from || left[0]?.until !== right[0]?.until;
  const quantitiesChanged =
    canonicalPublicationJson(left[0]?.refs ?? []) !==
    canonicalPublicationJson(right[0]?.refs ?? []);
  let line = `· ${label} 규칙·적용 기간 변경: ${from.length}구간 → ${to.length}구간`;
  if (from.length === 1 && to.length === 1) {
    line = quantitiesChanged
      ? `· ${label} 변경: ${refsLabel(from[0]?.[key] ?? [])} → ${refsLabel(to[0]?.[key] ?? [])}`
      : `· ${label} 적용 기간 변경`;
    if (datesChanged) line += `: ${ruleDateRange(from[0])} → ${ruleDateRange(to[0])}`;
  }
  return { kind: label, line };
}

function ruleDiffLines(before: ReviewCandidateView, after: ReviewCandidateView) {
  if (!before.certifiedSnapshot || !after.certifiedSnapshot)
    return {
      changes: [
        { kind: "인증 원장", line: "· 지급·상점·주간 키트·파견 구성: 인증 원장 없어 비교 불가" },
      ],
      windowShifted: false,
    };
  const rolling = rollingWindowShift(before, after);
  const changes: { kind: string; line: string }[] = [];
  for (const [label, key] of RULE_PARTS) {
    const change = rulePartChange(before, after, label, key, rolling);
    if (change) changes.push(change);
  }
  const comparisons: [string, unknown, unknown][] = [
    ["지급 내용·수령 기간", grantKey(before), grantKey(after)],
    ["보상 내용·확률", before.certifiedSnapshot.laws, after.certifiedSnapshot.laws],
    [
      "솔로 보상",
      before.certifiedSnapshot.rules.map((rule) => rule.soloDays.map(normalizedRefs)),
      after.certifiedSnapshot.rules.map((rule) => rule.soloDays.map(normalizedRefs)),
    ],
    ["콜라보 일정", before.schedule.collaborationPeriods, after.schedule.collaborationPeriods],
    ["파견 정책", before.dispatchPolicyId, after.dispatchPolicyId],
    ["추정 주기", before.schedule.cadenceDays, after.schedule.cadenceDays],
  ];
  for (const [label, left, right] of comparisons)
    if (canonicalPublicationJson(left) !== canonicalPublicationJson(right))
      changes.push({ kind: label, line: `· ${label} 변경` });
  return {
    changes,
    windowShifted:
      rolling &&
      changes.length === 0 &&
      before.certifiedSnapshot.rules.some(
        (rule) =>
          Date.parse(rule.effectiveFrom) ===
          Date.parse(before.certifiedSnapshot?.coverage.from ?? ""),
      ) &&
      after.certifiedSnapshot.rules.some(
        (rule) =>
          Date.parse(rule.effectiveFrom) ===
          Date.parse(after.certifiedSnapshot?.coverage.from ?? ""),
      ),
  };
}

function ruleDateRange(rule: { effectiveFrom: string; effectiveUntil: string | null } | undefined) {
  if (!rule) return "없음";
  return periodRange(
    Date.parse(rule.effectiveFrom),
    rule.effectiveUntil === null ? null : Date.parse(rule.effectiveUntil),
  );
}

/** Law references as counts, e.g. "일반 상자 5, Box II 5"; an unknown law keeps its id. */
function refsLabel(refs: Refs) {
  if (refs.length === 0) return "없음";
  return normalizedRefs(refs)
    .map(([id, count]) => `${LAW_KO[id]?.label ?? id} ${count}${LAW_KO[id]?.unit ?? ""}`)
    .join(", ");
}

function detailLines(candidate: ReviewCandidateView) {
  const allRounds = [...roundsByNumber(candidate).values()];
  const rounds = allRounds.filter((round) => !outsideWindow(round, candidate));
  const past = allRounds.length - rounds.length;
  const additional = Math.max(0, rounds.length - MAX_ROUND_LINES);
  const omitted = [
    ...(past ? [`지난 라운드 ${past}개 생략`] : []),
    ...(additional ? [`추가 라운드 ${additional}개 생략`] : []),
  ].join(" · ");
  const lines = [
    rounds.length
      ? `· 라운드: ${rounds
          .slice(-MAX_ROUND_LINES)
          .map((round) => `${round.round} ${roundRange(round)} (${statusKo(round.status)})`)
          .join(", ")}${omitted ? ` (${omitted})` : ""}`
      : "· 라운드 번호: 원장에 없음 (번호를 추정하지 않습니다)",
  ];
  const rules = candidate.certifiedSnapshot?.rules;
  if (!rules) return [...lines, "· 지급·상점·주간 키트·파견 구성: 인증 원장 없음"];
  for (const [label, key] of RULE_PARTS)
    lines.push(
      `· ${label}: ${oneLine(rules.map((rule) => refsLabel(rule[key] ?? [])).join(" / "), 150)}`,
    );
  lines.push(`· 지급 ${candidate.grants?.length ?? 0}건 · 보상 종류: ${rewardSummary(candidate)}`);
  return lines;
}

/** Keep whole reward labels, reserving room for the explicit omitted-kind count. */
function rewardSummary(candidate: ReviewCandidateView) {
  const labels = (candidate.certifiedSnapshot?.laws ?? []).map(
    (law) => LAW_KO[law.id]?.label ?? law.id,
  );
  const shown: string[] = [];
  for (const label of labels) {
    const remaining = labels.length - shown.length - 1;
    const next = [...shown, label, ...(remaining ? [`외 ${remaining}종`] : [])].join(" · ");
    if (next.length > REWARD_LABEL_LIMIT) break;
    shown.push(label);
  }
  const remaining = labels.length - shown.length;
  return [...shown, ...(remaining ? [`외 ${remaining}종`] : [])].join(" · ") || "없음";
}

/** "42, 43, 44" with a compact range when the numbers are consecutive. */
function summarizeNumbers(numbers: number[]) {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const consecutive = sorted.every(
    (value, index) => index === 0 || value === Number(sorted[index - 1]) + 1,
  );
  return consecutive && sorted.length > 2
    ? `${sorted[0]}~${sorted[sorted.length - 1]}`
    : sorted.join(", ");
}

/**
 * Plain-Korean facts about competing requests for the same turn: how many, which kinds,
 * and which of them target the game day in progress (05:00 KST boundary).
 */
function siblingBlock(review: ReviewRow, competition: ReviewCompetition, now: number) {
  const { counts, todayCount, newer } = competition;
  const total = counts.approve + counts.rollback + counts.off;
  const kinds = (["approve", "rollback", "off"] as const)
    .filter((action) => counts[action] > 0)
    .map((action) => `${ACTION_KO[action]} ${counts[action]}`)
    .join(" · ");
  const today = gameDayKey(now);
  return [
    `🔢 같은 차례(순번 ${review.expected_sequence})에 대기 중인 요청이 이 메시지 포함 ${total}건 있습니다: ${kinds}.`,
    `기준 게임일이 오늘(${today})인 후보 요청은 ${todayCount}건입니다. 하나를 반영하면 나머지는 이미 지난 요청이 됩니다.`,
    newer
      ? `· 더 최근 요청 있음: ${ACTION_KO[newer.action]}(후보 ${newer.candidateId ?? "없음"}, ${kstLabel(new Date(newer.createdAt).toISOString())} KST)`
      : "· 이 메시지가 가장 최근 요청입니다.",
  ].join("\n");
}

function activeBlock(active: ActiveRow, activeCandidate: ReviewCandidateView | null) {
  if (!active.candidate_id) return "📊 지금 반영된 것: 없음(끄기 상태)";
  const coverage = activeCandidate?.certifiedSnapshot?.coverage.currentDay;
  return `📊 지금 반영된 것: 후보 ${active.candidate_id}${coverage ? ` (기준 게임일 ${coverage})` : ""}`;
}

function sourceBlock(candidate: ReviewCandidateView | null) {
  if (!candidate) return null;
  const lines = candidate.sourceEvidence
    .slice(0, MAX_SOURCES)
    .map(
      (source) =>
        `🔗 근거 공지: ${oneLine(source.source, 40)}/${oneLine(source.itemId, 80)} · ${oneLine(source.url, 200)}`,
    );
  return lines.length ? lines.join("\n") : null;
}

function warningBlock(candidate: ReviewCandidateView | null) {
  if (!candidate || candidate.warnings.length === 0) return null;
  const warnings = candidate.warnings.map(translateCandidateWarning);
  return `⚠️ 후보 경고: ${warnings.join("; ")}`;
}

/** The "committed" follow-up: same guidance shape, no button, facts only. */
export function publicationResultContent(result: {
  environment: string;
  action: string;
  sequence: number;
  candidate_id: string | null;
  operationId: string;
}) {
  const action = ACTION_KO[result.action as PublicationAction] ?? oneLine(result.action, 20);
  const live =
    result.action === "off"
      ? "이 작업은 사이트 예보를 끄기로 처리했습니다."
      : `이 작업은 사이트 예보를 후보 ${result.candidate_id ?? "없음"} 내용으로 반영했습니다.`;
  return assemble(
    [
      `**Forecast ${action} 반영 완료** · 환경: ${result.environment}`,
      `✅ 처리 결과: ${live}`,
      `📊 처리 당시 순번: ${result.sequence} (이후 다른 작업으로 상태가 바뀌었을 수 있습니다)`,
      "👉 해 주실 일: 할 일 없음. 이 알림은 기록용이며, 되돌릴 때는 새 검토 메시지의 버튼을 사용하세요.",
    ],
    [],
    `기록용: 후보 ${result.candidate_id ?? "off"} · 시퀀스 ${result.sequence} · 작업 ${result.operationId}`,
  );
}

/** Compact audit trail; the only place the raw identifiers remain. */
function ledger(review: ReviewRow) {
  const hash = review.payload_hash ? ` · SHA-256 ${review.payload_hash.slice(0, 12)}…` : "";
  return `기록용: 후보 ${review.candidate_id ?? "off"}${hash} · 검토 ${review.review_id} · 시퀀스 ${review.expected_sequence}`;
}

/**
 * Adds optional blocks in priority order and always appends the ledger line. The action
 * and consequence lines are essential, so truncation can drop detail but never them.
 */
function assemble(essential: string[], optional: string[], ledgerLine: string) {
  let body = essential.join("\n");
  const reserved = `\n${oneLine(ledgerLine, 300)}`;
  // Normal detail lists are independently bounded. This final guard also covers
  // an unexpectedly large essential block without losing expiry or action guidance.
  if (body.length + reserved.length > CONTENT_LIMIT) {
    const perBlock = Math.floor(
      (CONTENT_LIMIT - reserved.length - (essential.length - 1)) / essential.length,
    );
    const marker = "… (세부 내용 생략)";
    body = essential
      .map((block) =>
        block.length > perBlock ? `${safeCut(block, perBlock - marker.length)}${marker}` : block,
      )
      .join("\n");
  }
  for (const block of optional) {
    const next = `${body}\n${block}`;
    if (next.length + reserved.length <= CONTENT_LIMIT) body = next;
  }
  return `${body}${reserved}`;
}

/** Cuts at most `maxUnits` UTF-16 units without splitting a surrogate pair (emoji). */
function safeCut(value: string, maxUnits: number) {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > Math.max(0, maxUnits)) break;
    result += character;
  }
  return result;
}

/** Single-line, control-character-free text so operator text cannot break the layout. */
function oneLine(value: string, maxLength: number) {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
