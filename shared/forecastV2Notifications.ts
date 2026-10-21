import { linkLabel, manualReviewPostLink } from "./forecastManualReview.ts";
import { FALLBACK_GUIDANCE, guidance } from "./forecastV2Guidance.ts";

/** Shared caps so producers clamp before validation ever rejects a queued message. */
export const V2_EVIDENCE_LIMITS = {
  goal: 120,
  reason: 64,
  item: 160,
  items: 6,
  blocked: 240,
  todo: 300,
} as const;

/**
 * Why a decision exists, in the approver's terms. Producers fill the facts they
 * already judged; the renderer turns `reason` into the guidance table line.
 * Every field is optional: outbox rows queued before this schema must still
 * validate and render through the fallback layout.
 */
export type ForecastV2DecisionEvidence = {
  goal?: string;
  reason?: string;
  postedAt?: string;
  confirmed?: string[];
  guessed?: string[];
  guess?: { startAt: string; endAt: string };
  /** Shown instead of "nothing extracted" when the decision is not about a period. */
  noGuess?: string;
  blocked?: string;
  todo?: string;
};

export type ForecastV2Payloads = {
  b_report: {
    feedId: number;
    title: string;
    url: string;
    postedAt: string;
    extracted: {
      complete?: boolean;
      segments: {
        kind: "open" | "suspend" | "resume" | "extend" | "reopen" | "close";
        startAt?: string;
        endAt?: string;
      }[];
      kits: { gameDay: string; ii: number; box: number }[];
    };
    /**
     * The decision's own extraction — exactly what apply uses (not the first
     * segment). Its `complete` decides whether [이 일정으로 확정] may be shown.
     */
    decision?: {
      complete: boolean;
      startAt?: string;
      endAt?: string;
      /** The same todo the stored decision will show, so both messages agree. */
      todo?: string;
    };
    decisionRequestId: string;
  };
  decision_request: {
    decisionRequestId: string;
    type: "grant_date" | "solo_review" | "collaboration" | "maintenance" | "grant_quantity";
    feedIds: number[];
    title: string;
    url: string;
    options: { id: string; label: string }[];
    expiresAt: string;
    extracted?: { complete?: boolean; startAt?: string; endAt?: string };
  } & ForecastV2DecisionEvidence;
  calendar_changed: {
    snapshotId: string;
    revision: number;
    adminUrl: string;
    changes: {
      kind: "solo" | "collaboration" | "maintenance" | "grant";
      label: string;
      change: "added" | "removed" | "changed";
      before?: string;
      after?: string;
    }[];
  };
  decision_reminder: {
    decisionRequestId: string;
    title?: string;
    url?: string;
    expiresAt?: string;
    /** Present when the producer knows the request type (always, after R1-44). */
    type?: ForecastV2Payloads["decision_request"]["type"];
  } & ForecastV2DecisionEvidence;
};
export type ForecastV2NotificationKind = keyof ForecastV2Payloads;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const id = (v: unknown): v is string => text(v) && /^[A-Za-z0-9_-]+$/.test(v);
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const one = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v);
function url(v: unknown, host: string) {
  if (!text(v)) return false;
  const u = URL.parse(v);
  return (
    !!u && u.protocol === "https:" && u.hostname === host && !u.username && !u.password && !u.port
  );
}
const optionalText = (v: unknown) => v === undefined || text(v);
const bounded = (v: unknown, limit: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= limit;
/** Evidence is optional in full and per field, so pre-evidence payloads still pass. */
function validateEvidence(v: Record<string, unknown>) {
  const limits = V2_EVIDENCE_LIMITS;
  return (
    (v["goal"] === undefined || bounded(v["goal"], limits.goal)) &&
    (v["reason"] === undefined || bounded(v["reason"], limits.reason)) &&
    (v["postedAt"] === undefined ||
      (text(v["postedAt"]) && Number.isFinite(Date.parse(v["postedAt"])))) &&
    (v["blocked"] === undefined || bounded(v["blocked"], limits.blocked)) &&
    (v["noGuess"] === undefined || bounded(v["noGuess"], limits.item)) &&
    (v["todo"] === undefined || bounded(v["todo"], limits.todo)) &&
    (v["guess"] === undefined ||
      (record(v["guess"]) && date(v["guess"]["startAt"]) && date(v["guess"]["endAt"]))) &&
    [v["confirmed"], v["guessed"]].every(
      (list) =>
        list === undefined ||
        (Array.isArray(list) &&
          list.length <= limits.items &&
          list.every((item) => bounded(item, limits.item))),
    )
  );
}
export function validateForecastV2Payload<K extends ForecastV2NotificationKind>(
  kind: K,
  v: unknown,
): v is ForecastV2Payloads[K] {
  if (!record(v)) return false;
  if (kind === "calendar_changed") return validateCalendarChanged(v);
  if (!id(v["decisionRequestId"])) return false;
  if (!validateEvidence(v)) return false;
  if (kind === "decision_reminder")
    return (
      (v["title"] === undefined || text(v["title"])) &&
      (v["url"] === undefined || url(v["url"], "game.naver.com")) &&
      (v["expiresAt"] === undefined || date(v["expiresAt"])) &&
      (v["type"] === undefined ||
        one(v["type"], [
          "grant_date",
          "solo_review",
          "collaboration",
          "maintenance",
          "grant_quantity",
        ]))
    );
  if (!text(v["title"]) || !url(v["url"], "game.naver.com")) return false;
  if (kind === "decision_request") return validateDecisionRequest(v);
  return kind === "b_report" && validateBReport(v);
}

function validateCalendarChanged(v: Record<string, unknown>) {
  return (
    text(v["snapshotId"]) &&
    integer(v["revision"]) &&
    url(v["adminUrl"], "forecast-admin-staging.nikkecollection.com") &&
    /\?rev=\d+#gd-\d{4}-\d{2}-\d{2}$/.test(String(v["adminUrl"])) &&
    Array.isArray(v["changes"]) &&
    v["changes"].every(
      (c) =>
        record(c) &&
        one(c["kind"], ["solo", "collaboration", "maintenance", "grant"]) &&
        text(c["label"]) &&
        one(c["change"], ["added", "removed", "changed"]) &&
        optionalText(c["before"]) &&
        optionalText(c["after"]),
    )
  );
}

function validateDecisionRequest(v: Record<string, unknown>) {
  return (
    one(v["type"], [
      "grant_date",
      "solo_review",
      "collaboration",
      "maintenance",
      "grant_quantity",
    ]) &&
    Array.isArray(v["feedIds"]) &&
    v["feedIds"].every(integer) &&
    date(v["expiresAt"]) &&
    Array.isArray(v["options"]) &&
    (one(v["type"], ["solo_review", "collaboration", "maintenance"]) || v["options"].length > 0) &&
    v["options"].length <=
      (["collaboration", "maintenance"].includes(String(v["type"])) ? 24 : 25) &&
    v["options"].every((o) => record(o) && id(o["id"]) && text(o["label"])) &&
    new Set(v["options"].map((o) => o.id)).size === v["options"].length &&
    (v["extracted"] === undefined ||
      (record(v["extracted"]) &&
        (v["extracted"]["complete"] === undefined ||
          typeof v["extracted"]["complete"] === "boolean") &&
        (v["extracted"]["startAt"] === undefined || date(v["extracted"]["startAt"])) &&
        (v["extracted"]["endAt"] === undefined || date(v["extracted"]["endAt"]))))
  );
}

function validateBReport(v: Record<string, unknown>) {
  if (!integer(v["feedId"]) || !date(v["postedAt"]) || !record(v["extracted"])) return false;
  const e = v["extracted"];
  return (
    Array.isArray(e["segments"]) &&
    e["segments"].every(
      (s) =>
        record(s) &&
        one(s["kind"], ["open", "suspend", "resume", "extend", "reopen", "close"]) &&
        (s["startAt"] === undefined || date(s["startAt"])) &&
        (s["endAt"] === undefined || date(s["endAt"])),
    ) &&
    Array.isArray(e["kits"]) &&
    e["kits"].every(
      (k) =>
        record(k) &&
        text(k["gameDay"]) &&
        /^\d{4}-\d{2}-\d{2}$/.test(k["gameDay"]) &&
        integer(k["ii"]) &&
        integer(k["box"]),
    ) &&
    (v["decision"] === undefined ||
      (record(v["decision"]) &&
        typeof v["decision"]["complete"] === "boolean" &&
        (v["decision"]["startAt"] === undefined || date(v["decision"]["startAt"])) &&
        (v["decision"]["endAt"] === undefined || date(v["decision"]["endAt"])) &&
        (v["decision"]["todo"] === undefined ||
          bounded(v["decision"]["todo"], V2_EVIDENCE_LIMITS.todo))))
  );
}
export function forecastV2CustomId(
  environment: "staging" | "production",
  action: "opt" | "bok" | "bedit" | "bno",
  decision: string,
  revision: number,
  option?: string,
) {
  const value = `fv2:${environment === "staging" ? "s" : "p"}:${action}:${decision}:${revision}${option === undefined ? "" : `:${option}`}`;
  if (
    !id(decision) ||
    !integer(revision) ||
    (option !== undefined && !id(option)) ||
    value.length > 100
  )
    throw new Error("v2_custom_id_invalid");
  return value;
}
export function renderForecastV2Notification<K extends ForecastV2NotificationKind>(
  kind: K,
  input: unknown,
  context: {
    environment: "staging" | "production";
    expectedRevision: number;
    idempotencyKey: string;
  },
) {
  if (!validateForecastV2Payload(kind, input)) throw new Error("v2_payload_invalid");
  if (!/^[A-Za-z0-9_:.-]{1,180}$/.test(context.idempotencyKey))
    throw new Error("v2_idempotency_key_invalid");
  const buttons: { type: number; style: number; label: string; custom_id: string }[] = [];
  const button = (
    decision: string,
    action: "opt" | "bok" | "bedit" | "bno",
    label: string,
    option?: string,
  ) =>
    buttons.push({
      type: 2,
      style: 2,
      // Button labels are plain text: break mention tokens but keep the label human
      // (markdown backslashes would show literally) and within Discord's 80-char cap.
      label: buttonLabel(label),
      custom_id: forecastV2CustomId(
        context.environment,
        action,
        decision,
        context.expectedRevision,
        option,
      ),
    });
  let body = "";
  if (kind === "b_report") {
    const p = input as ForecastV2Payloads["b_report"];
    const segments = segmentSummaries(p.extracted.segments);
    const kits = kitSummaries(p.extracted.kits);
    // Only the decision's own extraction is confirmable; it is exactly what apply uses.
    const window = p.decision
      ? rangeOf(p.decision.startAt, p.decision.endAt)
        ? { startAt: p.decision.startAt as string, endAt: p.decision.endAt as string }
        : undefined
      : undefined;
    const confirmable = p.decision?.complete === true && window !== undefined;
    const confirmLabel = "이 일정으로 확정";
    body = compose({
      title: p.title,
      url: p.url,
      postedAt: p.postedAt,
      goal: "B 게시판의 일정 변경 근거를 달력에 반영할지 확인",
      confirmed: [...segments, ...kits],
      guessed: [],
      manualEntry: true,
      actions: [...(confirmable ? [confirmLabel] : []), "일정 수정", "관련 없음"],
      rendered: [...(confirmable ? [confirmLabel] : []), "일정 수정", "관련 없음"],
      // Ask the explicit question only when a range backs the confirm button: a window
      // without `complete` renders no [이 일정으로 확정], so the question would promise a
      // button the message does not have.
      ...(confirmable && window
        ? { guess: window }
        : {
            noGuess: segments.length
              ? `읽은 구간: ${segments.join(" / ")}`
              : "공지에서 구간을 읽지 못해 직접 입력이 필요합니다.",
          }),
      reason: "b_evidence_only",
      todo:
        p.decision?.todo ??
        (confirmable
          ? "추출한 일정이 맞으면 [이 일정으로 확정], 다르면 [일정 수정]으로 직접 입력, 근거가 무관하면 [관련 없음]."
          : "공지의 변경 구간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 근거가 무관하면 [관련 없음]."),
    });
    if (confirmable) button(p.decisionRequestId, "bok", confirmLabel);
    button(p.decisionRequestId, "bedit", "일정 수정");
    button(p.decisionRequestId, "bno", "관련 없음");
  } else if (kind === "decision_request") {
    const p = input as ForecastV2Payloads["decision_request"];
    const extractedRange =
      p.extracted?.startAt && p.extracted.endAt
        ? { startAt: p.extracted.startAt, endAt: p.extracted.endAt }
        : undefined;
    // Only a solo review has a confirm button (permitsAction admits bok there alone),
    // so only a solo review asks "이 일정(…)으로 하면 될까요?". Grant and
    // collaboration/maintenance payloads carry `extracted` for bookkeeping only.
    const guess = p.type === "solo_review" ? (p.guess ?? extractedRange) : p.guess;
    const guessRange = guess ? rangeOf(guess.startAt, guess.endAt) : undefined;
    const useGuess = Boolean(guessRange) && guess !== undefined;
    // Options are always buttons for non-solo requests; echo their visible labels as
    // the guess so the message never claims nothing was found while buttons exist.
    // Grant options are actions ("별도 지급"/"정정"), not windows, so they are excluded.
    // Echo only option labels that are real windows: "관련 없음"/"기존 점검 유지"
    // are actions, not candidates, so they must not be reported as read windows.
    const optionLabels =
      p.type === "collaboration" || p.type === "maintenance"
        ? p.options
            .map((o) => optionLabel(o.label))
            .filter((label) => /\d{1,2}:\d{2}|\d{4}\/\d{2}\/\d{2}/.test(label))
        : [];
    const soloConfirm = guessRange ? "이 일정으로 확정" : "확정";
    const optionLabelsForButtons = p.options.map((o) => optionLabel(o.label));
    // A solo review renders only action buttons; every other type renders its options.
    const rendered =
      p.type === "solo_review"
        ? [...(p.extracted?.complete === true ? [soloConfirm] : []), "일정 수정", "관련 없음"]
        : [
            ...optionLabelsForButtons,
            ...(["collaboration", "maintenance"].includes(p.type) ? ["일정 수정"] : []),
          ];
    // Only the non-option buttons need naming in the todo; options speak for themselves.
    // A solo review has no options, so all of its buttons are actions.
    const actions =
      p.type === "solo_review"
        ? rendered
        : rendered.filter((label) => !optionLabelsForButtons.includes(label));
    body = compose({
      title: p.title,
      url: p.url,
      ...(p.postedAt ? { postedAt: p.postedAt } : {}),
      goal: p.goal ?? GOALS[p.type],
      confirmed: p.confirmed ?? [],
      guessed: p.guessed ?? [],
      actions,
      rendered,
      ...(legacyRequest(p) ? { legacyFormat: true } : {}),
      // Only solo/collaboration/maintenance requests render [일정 수정].
      manualEntry: ["solo_review", "collaboration", "maintenance"].includes(p.type),
      ...(p.type === "grant_date" || p.type === "grant_quantity"
        ? { noGuess: p.noGuess ?? "지급일 후보를 아래 버튼으로 모았습니다." }
        : p.noGuess
          ? { noGuess: p.noGuess }
          : {}),
      ...(useGuess && guess ? { guess } : {}),
      ...(useGuess || !optionLabels.length ? {} : { fallbackGuess: optionLabels }),
      reason: p.reason ?? DEFAULT_REASONS[p.type],
      ...(p.blocked ? { blocked: p.blocked } : {}),
      ...(p.todo ? { todo: p.todo } : {}),
      expiresAt: p.expiresAt,
    });
    if (p.type === "solo_review") {
      // bok is only admitted by permitsAction for a complete solo extraction.
      if (p.extracted?.complete === true) button(p.decisionRequestId, "bok", soloConfirm);
      button(p.decisionRequestId, "bedit", "일정 수정");
      button(p.decisionRequestId, "bno", "관련 없음");
    } else {
      for (const option of p.options)
        button(p.decisionRequestId, "opt", optionLabel(option.label), option.id);
      if (["collaboration", "maintenance"].includes(p.type))
        button(p.decisionRequestId, "bedit", "일정 수정");
    }
  } else if (kind === "calendar_changed") {
    const p = input as ForecastV2Payloads["calendar_changed"];
    const admin = new URL(p.adminUrl);
    admin.search = `?rev=${p.revision}`;
    const changes = p.changes
      .slice(0, V2_EVIDENCE_LIMITS.items)
      .map(
        (change) =>
          `• ${{ added: "추가", removed: "삭제", changed: "변경" }[change.change]} [${{ solo: "솔로", collaboration: "콜라보", maintenance: "점검", grant: "지급" }[change.kind]}] ${changeLabel(change.label)}: ${changeValue(change.before)} → ${changeValue(change.after)}`,
      );
    body =
      `🗓 달력 변경 (rev ${p.revision})\n` +
      (changes.length ? `${changes.join("\n")}\n` : "• 의미 있는 변경 없음\n");
    const link = `\n[달력 보기](${admin.href})`;
    body = cap(body, 2000 - link.length - context.idempotencyKey.length - 4) + link;
  } else {
    const p = input as ForecastV2Payloads["decision_reminder"];
    // Reminders repeat the stored evidence; without it nothing about the judgment is
    // known, so only the type-based goal is safe to show.
    body = compose({
      title: p.title ?? "결정 대기 알림",
      ...(p.url ? { url: p.url } : {}),
      ...(p.postedAt ? { postedAt: p.postedAt } : {}),
      goal: p.goal ?? (p.type ? GOALS[p.type] : "결정 대기 중인 요청 확인"),
      confirmed: p.confirmed ?? [],
      guessed: p.guessed ?? [],
      ...(p.noGuess ? { noGuess: p.noGuess } : {}),
      ...(p.guess ? { guess: p.guess } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.blocked ? { blocked: p.blocked } : {}),
      // Buttons live on the original request message, not on this reminder.
      todo: p.todo ?? "원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
      ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
      ...(legacyRequest(p) ? { legacyFormat: true } : {}),
    });
  }
  const marker = `ref:${context.idempotencyKey}`;
  return {
    allowed_mentions: { parse: [] as string[] },
    embeds: [{ description: cap(body, 2000 - marker.length), footer: { text: marker } }],
    components: Array.from({ length: Math.ceil(buttons.length / 5) }, (_, i) => ({
      type: 1,
      components: buttons.slice(i * 5, i * 5 + 5),
    })),
  };
}
/** A request row queued before the evidence schema stored no facts about the judgment. */
function legacyRequest(payload: ForecastV2DecisionEvidence) {
  return (
    payload.goal === undefined &&
    payload.confirmed === undefined &&
    payload.guessed === undefined &&
    payload.reason === undefined &&
    payload.blocked === undefined &&
    payload.todo === undefined &&
    payload.noGuess === undefined &&
    payload.guess === undefined
  );
}
function cap(value: string, limit: number) {
  return value.length <= limit ? value : value.slice(0, limit - 5) + "…(생략)";
}
/** Plain-text button label: no mention tokens, no markdown, at most 80 characters. */
function buttonLabel(value: string) {
  return value
    .replaceAll("@", "@\u200b")
    .replaceAll("<", "<\u200b")
    .replace(/[[\]]/g, (bracket) => (bracket === "[" ? "［" : "］"))
    .slice(0, 80);
}

const SEGMENT_LABELS = {
  open: "시작",
  suspend: "중단",
  resume: "재개",
  extend: "연장",
  reopen: "재오픈",
  close: "종료",
} as const;

/**
 * Keep whichever endpoints a segment actually has; never collapse a known side.
 * For a suspension the end instant is the resume time, which is what approvers
 * compare against the notice.
 */
function segmentSummaries(segments: ForecastV2Payloads["b_report"]["extracted"]["segments"]) {
  return segments.map((segment) => {
    const label = SEGMENT_LABELS[segment.kind];
    const range = rangeOf(segment.startAt, segment.endAt);
    if (range) return `${label}: ${range}`;
    const [startWord, endWord] =
      segment.kind === "suspend" ? ["중단 시작", "재개"] : [`${label} 시작`, `${label} 종료`];
    if (segment.startAt) return `${startWord}: ${kstLabel(segment.startAt)}, ${endWord}: 미확정`;
    if (segment.endAt) return `${endWord}: ${kstLabel(segment.endAt)}, ${startWord}: 미확정`;
    return `${label}: 시각 미확정`;
  });
}

function kitSummaries(kits: ForecastV2Payloads["b_report"]["extracted"]["kits"]) {
  return kits.map(
    (kit) =>
      `${kstLabel(`${kit.gameDay}T00:00:00+09:00`).slice(0, 8)} 관리 키트 II ${kit.ii} · 상자 ${kit.box}`,
  );
}
const GOALS: Record<ForecastV2Payloads["decision_request"]["type"], string> = {
  solo_review: "솔로 레이드 일정 확정",
  maintenance: "점검 일정 확정",
  collaboration: "콜라보 일정 확정",
  grant_date: "보상 지급일 확정",
  grant_quantity: "지급 수량 확인",
};
const DEFAULT_REASONS: Record<ForecastV2Payloads["decision_request"]["type"], string> = {
  solo_review: "solo_period_unresolved",
  maintenance: "maintenance_period_missing",
  collaboration: "collaboration_start_unresolved",
  grant_date: "grant_date",
  grant_quantity: "grant_quantity",
};
export const decisionGoal = (type: ForecastV2Payloads["decision_request"]["type"]) => GOALS[type];
export const defaultReason = (type: ForecastV2Payloads["decision_request"]["type"]) =>
  DEFAULT_REASONS[type];
const WEEKDAYS = "일월화수목금토";

/** Every instant is shown as KST `MM/DD(요일) HH:mm`; never a raw ISO string. */
export function kstLabel(instant: string): string {
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return "시각 확인 필요";
  return kst(at);
}
function kst(at: number): string {
  const value = new Date(at + 9 * 3_600_000).toISOString();
  return `${value.slice(5, 7)}/${value.slice(8, 10)}(${WEEKDAYS[new Date(at + 9 * 3_600_000).getUTCDay()]}) ${value.slice(11, 16)}`;
}
function rangeOf(startAt: string | undefined, endAt: string | undefined) {
  if (!startAt || !endAt) return undefined;
  const start = Date.parse(startAt),
    end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return `${kst(start)} ~ ${kst(end)}`;
}
function heading(title: string, url: string | undefined, postedAt: string | undefined) {
  const label = url ? manualReviewPostLink(title, url) : linkLabel(title);
  return `🔎 ${label}${postedAt ? ` · 게시 ${kst(Date.parse(postedAt))}` : ""}`;
}
/** Human button label: KST dates instead of raw ISO, everything else verbatim. */
function optionLabel(label: string) {
  // Accept any RFC 3339 offset sign; an unparsable stamp is escaped rather than thrown.
  const stamp = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
  const human = label.replace(stamp, (value) => {
    const iso = /[Z]|[+-]\d{2}:?\d{2}$/.test(value)
      ? value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
      : `${value.replace(" ", "T")}+09:00`;
    const at = Date.parse(iso);
    return Number.isFinite(at) ? kst(at) : value;
  });
  return human
    .replace(/\s*\(KST\)/g, "")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_all, year: string, month: string, day: string) => {
      const at = Date.parse(`${year}-${month}-${day}T00:00:00+09:00`);
      return Number.isFinite(at) ? kst(at).slice(0, 8) : `${month}/${day}`;
    });
}
/** Grant labels are game days; render the same KST date form as everything else. */
function changeLabel(label: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(label)
    ? kstLabel(`${label}T00:00:00+09:00`).slice(0, 8)
    : linkLabel(label);
}
/** Calendar diff values carry JSON snapshots; show their schedule in KST. */
function changeValue(value: string | undefined) {
  if (!value) return "없음";
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed["startAt"] === "string" && typeof parsed["endAt"] === "string")
      return rangeOf(parsed["startAt"], parsed["endAt"]) ?? "일정 확인 필요";
    if (typeof parsed["gameDay"] === "string")
      return `${kstLabel(`${parsed["gameDay"]}T00:00:00+09:00`).slice(0, 8)} 관리 키트 II ${Number(parsed["ii"] ?? 0)} · 상자 ${Number(parsed["box"] ?? 0)}`;
  } catch {
    // A plain label is already human text.
  }
  return linkLabel(value);
}
function compose(input: {
  title: string;
  url?: string;
  postedAt?: string;
  goal: string;
  confirmed: string[];
  guessed: string[];
  guess?: { startAt: string; endAt: string };
  /** Visible option labels, used when no window exists but buttons do. */
  fallbackGuess?: string[];
  noGuess?: string;
  reason?: string;
  blocked?: string;
  todo?: string;
  expiresAt?: string;
  /** This request renders [일정 수정], so direct input is a real option. */
  manualEntry?: boolean;
  /** Labels of the non-option buttons this message renders (must be offered). */
  actions?: string[];
  /** Every button label this message renders (references outside it are dropped). */
  rendered?: string[];
  /** No evidence was stored at all (rows queued before the evidence schema). */
  legacyFormat?: boolean;
}) {
  const table = guidance(input.reason);
  const range = input.guess ? rangeOf(input.guess.startAt, input.guess.endAt) : undefined;
  // Escape first (display normalization), then budget (length), never the reverse: a
  // clip must not cut an escape sequence in half.
  const goal = clip(escapeDisplay(input.goal), V2_EVIDENCE_LIMITS.goal);
  const blocked = clip(
    escapeDisplay(
      input.blocked ??
        (input.legacyFormat
          ? "이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다"
          : (table ?? FALLBACK_GUIDANCE)[0]),
    ),
    V2_EVIDENCE_LIMITS.blocked,
  );
  // The table line is written for the buttons that reason's request renders; only an
  // unmapped reason falls back to the branch-specific default. Action references are
  // reserved before the prose is clipped, so the todo can never drop a button name.
  const todo = budgetTodo(
    input.todo ??
      table?.[1] ??
      (input.manualEntry
        ? "공지 원문을 확인해 맞으면 [일정 수정]으로 시작·종료를 직접 입력하고, 무관하면 [관련 없음]을 눌러 주세요."
        : "원래 결정 요청 메시지에서 맞는 버튼을 눌러 주세요."),
    input.actions,
    input.rendered,
  );
  const confirmed = evidenceList(input.confirmed);
  const guessed = evidenceList(input.guessed);
  const fallbackGuess = evidenceList(input.fallbackGuess ?? []);
  // `noGuess` is producer prose, so it gets the same one-item bound as evidence: a
  // payload may carry many segments and none of them may displace the guidance.
  const noGuess =
    input.noGuess === undefined
      ? undefined
      : clip(escapeDisplay(input.noGuess), V2_EVIDENCE_LIMITS.item);

  // Legacy rows store no facts, so the fallbacks must not invent them.
  const emptyConfirmed = input.legacyFormat
    ? "✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다"
    : "✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다";
  const emptyGuessed = input.legacyFormat
    ? "🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다"
    : input.manualEntry
      ? "🤔 추측한 것: 일정을 확인하지 못했습니다. [일정 수정]으로 직접 입력해 주세요."
      : "🤔 추측한 것: 일정을 확인하지 못했습니다. 원래 결정 요청 메시지의 버튼을 눌러 주세요.";

  // The heading keeps a valid masked link; only its visible text is shortened. The link
  // is part of the budget below, not a fixed cost on top of it.
  const middle = (itemLimit: number, titleLimit: number, url: string | undefined) => {
    const lines = [
      heading(clipTitle(input.title, titleLimit), url, input.postedAt),
      `하려던 일: ${goal}`,
    ];
    lines.push(
      confirmed.items.length ? `✅ 확인한 것: ${listLine(confirmed, itemLimit)}` : emptyConfirmed,
    );
    if (range) lines.push(`🤔 추측한 것: 이 일정(${range})으로 하면 될까요?`);
    else if (input.guess)
      lines.push("🤔 추측한 것: 이 일정으로 하면 될까요? (공지에서 추출한 시작·종료)");
    else if (guessed.items.length)
      lines.push(`🤔 추측한 것: 읽은 후보 ${listLine(guessed, itemLimit)}`);
    else if (noGuess) lines.push(`🤔 추측한 것: ${noGuess}`);
    else if (fallbackGuess.items.length)
      lines.push(`🤔 추측한 것: 읽은 후보 ${listLine(fallbackGuess, itemLimit)}`);
    else lines.push(emptyGuessed);
    lines.push(`❌ 막힌 이유: ${blocked}`);
    lines.push(`👉 해 주실 일: ${todo}`);
    return lines;
  };
  const tail = input.expiresAt ? [`만료 ${kstLabel(input.expiresAt)} KST`] : [];
  // Fixed sections (goal, reason, action, expiry) are reserved first; then the evidence
  // lists lose items ("외 N건"), and only after that does the heading text shrink.
  const room = V2_MESSAGE_BUDGET - tail.join("\n").length - 1;
  /** Shrink the evidence lists, then the visible title, until the body fits `room`. */
  const fitted = (url: string | undefined) => {
    let titleLimit = V2_EVIDENCE_LIMITS.goal + 80;
    let limit = V2_EVIDENCE_LIMITS.item * V2_EVIDENCE_LIMITS.items;
    while (middle(limit, titleLimit, url).join("\n").length > room) {
      if (limit > 12) limit -= 10;
      else if (titleLimit > 12) titleLimit -= 10;
      else break;
    }
    return middle(limit, titleLimit, url).join("\n");
  };
  let body = fitted(input.url);
  // A notice URL longer than the leftover budget must never push the reason, the
  // guidance or the expiry out of the message: the heading text still names the post.
  if (body.length > room) body = fitted(undefined);
  return [body, ...tail].join("\n");
}

/** Shorten the visible title text while `manualReviewPostLink` keeps the URL intact. */
function clipTitle(title: string, limit: number) {
  // Escaping can expand text (brackets → ［］), so measure the escaped form.
  const escaped = escapeDisplay(title);
  return escaped.length <= limit
    ? title
    : title.slice(0, Math.max(1, Math.min(title.length, limit))).trimEnd();
}

/** Whole embed budget: marker + escaping slack stays below Discord's 2000-char cap. */
const V2_MESSAGE_BUDGET = 1800;

/**
 * Escape, drop references to buttons this message lacks, append missing action buttons,
 * then clip the prose around them: action references are reserved and never cut.
 */
function budgetTodo(
  todo: string,
  actions: readonly string[] | undefined,
  rendered: readonly string[] | undefined,
) {
  const limit = V2_EVIDENCE_LIMITS.todo;
  let text = todo;
  if (rendered)
    for (const reference of new Set(text.match(/\[[^\]]+\]/g) ?? []))
      if (!rendered.some((label) => reference === `[${label}]`))
        text = text.replaceAll(reference, "");
  if (actions) {
    const missing = actions.filter((label) => !text.includes(`[${label}]`));
    if (missing.length)
      text = `${text.replace(/[,\s]+$/, "")}${text.endsWith(".") ? "" : "."} 그 밖에 ${missing
        .map((label) => `[${label}]`)
        .join(", ")} 버튼도 있습니다.`;
  }
  text = text.replace(/\s{2,}/g, " ").trim();
  const escaped = escapeDisplay(text);
  if (escaped.length <= limit) return escaped;
  // Keep every button reference, spend the remaining length on the surrounding prose.
  const references = [...new Set(escaped.match(/\[[^\]]+\]/g) ?? [])];
  const prose = references.reduce((value, reference) => value.replaceAll(reference, ""), escaped);
  const room = limit - references.join(" ").length - 1;
  const keptProse = room > 1 ? clip(prose.replace(/\s{2,}/g, " ").trim(), room) : "";
  // Re-append them as-is so a truncated todo still names every action.
  return clip(`${keptProse} ${references.join(" ")}`.trim(), limit);
}

function listLine(list: { items: string[]; dropped: number }, limit: number) {
  const shown: string[] = [];
  let used = 0;
  let dropped = list.dropped;
  for (const item of list.items) {
    const separator = shown.length ? " · " : "";
    if (used + separator.length + item.length > limit) {
      dropped++;
      continue;
    }
    shown.push(item);
    used += separator.length + item.length;
  }
  const text = shown.join(" · ");
  return dropped ? `${text}${text ? " · " : ""}외 ${dropped}건` : text || "항목 없음";
}

/** Evidence items are display text: escaped, newline-collapsed, length-bounded. */
function evidenceList(values: readonly string[]) {
  const items = values.map(evidenceText).filter((item) => item.length > 0);
  const kept = items.slice(0, V2_EVIDENCE_LIMITS.items);
  return { items: kept, dropped: items.length - kept.length };
}

function evidenceText(value: string) {
  return clip(escapeDisplay(value), V2_EVIDENCE_LIMITS.item);
}

/** Display normalization only: no markdown, links or mention tokens, one line. */
function escapeDisplay(value: string) {
  // Same escaping as titles; one line only so sections cannot be forged.
  // linkLabel backslash-escapes "~" because it builds link labels; in an embed a lone
  // "~" is harmless and ranges read better unescaped, while "~~" (strikethrough) stays
  // neutralised as full-width tildes.
  return linkLabel(value.replace(/[\r\n]+/g, " ").trim())
    .replace(/\\~\\~/g, "～～")
    .replace(/\\~/g, "~");
}

/** Length budgeting only, applied after escaping so no escape pair is split. */
function clip(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
