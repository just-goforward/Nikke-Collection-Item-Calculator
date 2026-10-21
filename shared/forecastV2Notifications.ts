import { linkLabel, manualReviewPostLink } from "./forecastManualReview.ts";
import { type ComposeInput, compose, escapeDisplay } from "./forecastV2Messages.ts";

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
/** Request types that render [일정 수정], so an empty option list is still valid. */
const EDITABLE_REQUEST_TYPES = ["solo_review", "collaboration", "maintenance"];
/** Option lists that are calendar windows, which cap one entry lower than actions. */
const WINDOW_OPTION_TYPES = ["collaboration", "maintenance"];
/** A field that may be absent but, when present, must be bounded display text. */
const optionalBounded = (v: unknown, limit: number) => v === undefined || bounded(v, limit);
const optionalDate = (v: unknown) => v === undefined || date(v);
const optionalBoolean = (v: unknown) => v === undefined || typeof v === "boolean";
/** One of a fixed label table's own keys; the table is also the renderer's source. */
const oneOf = (v: unknown, table: object) => typeof v === "string" && Object.hasOwn(table, v);
/** Evidence lists are optional, bounded in count, and every kept item is bounded. */
function boundedItems(v: unknown) {
  return (
    v === undefined ||
    (Array.isArray(v) &&
      v.length <= V2_EVIDENCE_LIMITS.items &&
      v.every((item) => bounded(item, V2_EVIDENCE_LIMITS.item)))
  );
}
function validateGuessSpan(v: unknown) {
  return v === undefined || (record(v) && date(v["startAt"]) && date(v["endAt"]));
}
/** Evidence is optional in full and per field, so pre-evidence payloads still pass. */
function validateEvidence(v: Record<string, unknown>) {
  const limits = V2_EVIDENCE_LIMITS;
  return (
    optionalBounded(v["goal"], limits.goal) &&
    optionalBounded(v["reason"], limits.reason) &&
    optionalDate(v["postedAt"]) &&
    optionalBounded(v["blocked"], limits.blocked) &&
    optionalBounded(v["noGuess"], limits.item) &&
    optionalBounded(v["todo"], limits.todo) &&
    validateGuessSpan(v["guess"]) &&
    boundedItems(v["confirmed"]) &&
    boundedItems(v["guessed"])
  );
}
export function validateForecastV2Payload<K extends ForecastV2NotificationKind>(
  kind: K,
  v: unknown,
): v is ForecastV2Payloads[K] {
  if (!record(v)) return false;
  if (kind === "calendar_changed") return validateCalendarChanged(v);
  return id(v["decisionRequestId"]) && validateEvidence(v) && validateRequestOrReport(kind, v);
}

/** Reminders and reports share the request identity but not the post metadata. */
function validateRequestOrReport(kind: ForecastV2NotificationKind, v: Record<string, unknown>) {
  if (kind === "decision_reminder") return validateReminder(v);
  if (!text(v["title"]) || !url(v["url"], "game.naver.com")) return false;
  if (kind === "decision_request") return validateDecisionRequest(v);
  return kind === "b_report" && validateBReport(v);
}

/**
 * A reminder repeats stored evidence, so its heading and expiry are both optional;
 * only the type, when present, must be one this renderer knows.
 */
function validateReminder(v: Record<string, unknown>) {
  return (
    optionalText(v["title"]) &&
    (v["url"] === undefined || url(v["url"], "game.naver.com")) &&
    optionalDate(v["expiresAt"]) &&
    (v["type"] === undefined || oneOf(v["type"], GOALS))
  );
}

function validateCalendarChanged(v: Record<string, unknown>) {
  return (
    text(v["snapshotId"]) &&
    integer(v["revision"]) &&
    url(v["adminUrl"], "forecast-admin-staging.nikkecollection.com") &&
    /\?rev=\d+#gd-\d{4}-\d{2}-\d{2}$/.test(String(v["adminUrl"])) &&
    Array.isArray(v["changes"]) &&
    v["changes"].every(validateCalendarChange)
  );
}

function validateCalendarChange(change: unknown) {
  return (
    record(change) &&
    oneOf(change["kind"], KIND_LABELS) &&
    text(change["label"]) &&
    oneOf(change["change"], CHANGE_LABELS) &&
    optionalText(change["before"]) &&
    optionalText(change["after"])
  );
}

function validateDecisionRequest(v: Record<string, unknown>) {
  return (
    oneOf(v["type"], GOALS) &&
    Array.isArray(v["feedIds"]) &&
    v["feedIds"].every(integer) &&
    date(v["expiresAt"]) &&
    Array.isArray(v["options"]) &&
    validateOptions(v["options"], String(v["type"])) &&
    (v["extracted"] === undefined || validateExtracted(v["extracted"]))
  );
}

/** Request types without options still need at least one; windows cap one lower. */
function validateOptions(options: unknown[], type: string) {
  if (!EDITABLE_REQUEST_TYPES.includes(type) && options.length === 0) return false;
  const limit = WINDOW_OPTION_TYPES.includes(type) ? 24 : 25;
  return (
    options.length <= limit &&
    options.every((option) => record(option) && id(option["id"]) && text(option["label"])) &&
    new Set(options.map((option) => (option as { id: string }).id)).size === options.length
  );
}

function validateExtracted(extracted: unknown) {
  return (
    record(extracted) &&
    optionalBoolean(extracted["complete"]) &&
    optionalDate(extracted["startAt"]) &&
    optionalDate(extracted["endAt"])
  );
}

const SEGMENT_KINDS = ["open", "suspend", "resume", "extend", "reopen", "close"];

function validateSegment(segment: unknown) {
  return (
    record(segment) &&
    one(segment["kind"], SEGMENT_KINDS) &&
    optionalDate(segment["startAt"]) &&
    optionalDate(segment["endAt"])
  );
}

/** Kits are reported as game days; the quantity counter caps each one. */
function validateKit(kit: unknown) {
  return (
    record(kit) &&
    text(kit["gameDay"]) &&
    /^\d{4}-\d{2}-\d{2}$/.test(kit["gameDay"]) &&
    integer(kit["ii"]) &&
    integer(kit["box"])
  );
}

function validateBDecision(decision: unknown) {
  return (
    record(decision) &&
    typeof decision["complete"] === "boolean" &&
    optionalDate(decision["startAt"]) &&
    optionalDate(decision["endAt"]) &&
    optionalBounded(decision["todo"], V2_EVIDENCE_LIMITS.todo)
  );
}

function validateBReport(v: Record<string, unknown>) {
  if (!integer(v["feedId"]) || !date(v["postedAt"]) || !record(v["extracted"])) return false;
  const extracted = v["extracted"];
  return (
    Array.isArray(extracted["segments"]) &&
    extracted["segments"].every(validateSegment) &&
    Array.isArray(extracted["kits"]) &&
    extracted["kits"].every(validateKit) &&
    (v["decision"] === undefined || validateBDecision(v["decision"]))
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
type DiscordButton = { type: number; style: number; label: string; custom_id: string };
type RenderContext = {
  environment: "staging" | "production";
  expectedRevision: number;
  idempotencyKey: string;
};
type ButtonAction = "opt" | "bok" | "bedit" | "bno";
type PushButton = (decision: string, action: ButtonAction, label: string, option?: string) => void;

export function renderForecastV2Notification<K extends ForecastV2NotificationKind>(
  kind: K,
  input: unknown,
  context: RenderContext,
) {
  if (!validateForecastV2Payload(kind, input)) throw new Error("v2_payload_invalid");
  if (!/^[A-Za-z0-9_:.-]{1,180}$/.test(context.idempotencyKey))
    throw new Error("v2_idempotency_key_invalid");
  const buttons: DiscordButton[] = [];
  const body = bodyFor(kind, input, context, buttons);
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

/** Each kind renders its own body; only the kind that has them pushes buttons. */
function bodyFor(
  kind: ForecastV2NotificationKind,
  input: unknown,
  context: RenderContext,
  buttons: DiscordButton[],
) {
  if (kind === "b_report")
    return bReportBody(input as ForecastV2Payloads["b_report"], buttons, context);
  if (kind === "decision_request")
    return decisionRequestBody(input as ForecastV2Payloads["decision_request"], buttons, context);
  if (kind === "calendar_changed")
    return calendarChangedBody(input as ForecastV2Payloads["calendar_changed"], context);
  return reminderBody(input as ForecastV2Payloads["decision_reminder"]);
}

function buttonPusher(buttons: DiscordButton[], context: RenderContext): PushButton {
  return (decision, action, label, option) =>
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
}

const B_CONFIRM = "이 일정으로 확정";

/** The span a B report may confirm: complete extraction *and* a usable range. */
function confirmableSpan(decision: ForecastV2Payloads["b_report"]["decision"]) {
  if (decision?.complete !== true) return undefined;
  const range = rangeOf(decision.startAt, decision.endAt);
  return range && decision.startAt && decision.endAt
    ? { startAt: decision.startAt, endAt: decision.endAt }
    : undefined;
}

function bReportBody(
  p: ForecastV2Payloads["b_report"],
  buttons: DiscordButton[],
  context: RenderContext,
) {
  const segments = segmentSummaries(p.extracted.segments);
  const kits = kitSummaries(p.extracted.kits);
  // Only the decision's own extraction is confirmable; it is exactly what apply uses.
  const window = confirmableSpan(p.decision);
  const actions = [...(window ? [B_CONFIRM] : []), "일정 수정", "관련 없음"];
  const body = renderBody(
    {
      goal: "B 게시판의 일정 변경 근거를 달력에 반영할지 확인",
      confirmed: [...segments, ...kits],
      guessed: [],
      manualEntry: true,
      actions,
      rendered: actions,
      // Ask the explicit question only when a range backs the confirm button: a window
      // without `complete` renders no [이 일정으로 확정], so the question would promise a
      // button the message does not have.
      ...(window ? { guess: window } : { noGuess: bReadSpan(segments) }),
      reason: "b_evidence_only",
      todo: p.decision?.todo ?? bReportTodo(Boolean(window)),
    },
    { title: p.title, url: p.url, postedAt: p.postedAt },
  );
  const push = buttonPusher(buttons, context);
  if (window) push(p.decisionRequestId, "bok", B_CONFIRM);
  push(p.decisionRequestId, "bedit", "일정 수정");
  push(p.decisionRequestId, "bno", "관련 없음");
  return body;
}

function bReadSpan(segments: readonly string[]) {
  return segments.length
    ? `읽은 구간: ${segments.join(" / ")}`
    : "공지에서 구간을 읽지 못해 직접 입력이 필요합니다.";
}

function bReportTodo(confirmable: boolean) {
  return confirmable
    ? "추출한 일정이 맞으면 [이 일정으로 확정], 다르면 [일정 수정]으로 직접 입력, 근거가 무관하면 [관련 없음]."
    : "공지의 변경 구간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 근거가 무관하면 [관련 없음].";
}

/** The buttons a decision request renders, and the ones the todo may name. */
function requestLayout(p: ForecastV2Payloads["decision_request"]) {
  const extracted =
    p.extracted?.startAt && p.extracted.endAt
      ? { startAt: p.extracted.startAt, endAt: p.extracted.endAt }
      : undefined;
  // Only a solo review has a confirm button (permitsAction admits bok there alone),
  // so only a solo review asks "이 일정(…)으로 하면 될까요?". Grant and
  // collaboration/maintenance payloads carry `extracted` for bookkeeping only.
  const guess = p.type === "solo_review" ? (p.guess ?? extracted) : p.guess;
  const guessRange = guess ? rangeOf(guess.startAt, guess.endAt) : undefined;
  const useGuess = Boolean(guessRange) && guess !== undefined;
  const optionLabelsForButtons = p.options.map((option) => optionLabel(option.label));
  const soloConfirm = guessRange ? B_CONFIRM : "확정";
  // A solo review renders only action buttons; every other type renders its options.
  const rendered =
    p.type === "solo_review"
      ? [...(p.extracted?.complete === true ? [soloConfirm] : []), "일정 수정", "관련 없음"]
      : [
          ...optionLabelsForButtons,
          ...(EDITABLE_REQUEST_TYPES.includes(p.type) ? ["일정 수정"] : []),
        ];
  // Only the non-option buttons need naming in the todo; options speak for themselves.
  // A solo review has no options, so all of its buttons are actions.
  const actions =
    p.type === "solo_review"
      ? rendered
      : rendered.filter((label) => !optionLabelsForButtons.includes(label));
  return {
    guess: useGuess ? guess : undefined,
    fallbackGuess: guessFallback(p, useGuess),
    rendered,
    actions,
    soloConfirm,
    optionLabelsForButtons,
  };
}

/**
 * Options are always buttons for non-solo requests; echo their visible labels as the
 * guess so the message never claims nothing was found while buttons exist. Grant
 * options are actions ("별도 지급"/"정정"), not windows, so they are excluded, and
 * "관련 없음"/"기존 점검 유지" are actions rather than candidates.
 */
function guessFallback(p: ForecastV2Payloads["decision_request"], useGuess: boolean) {
  const candidates =
    p.type === "collaboration" || p.type === "maintenance"
      ? p.options
          .map((option) => optionLabel(option.label))
          .filter((label) => /\d{1,2}:\d{2}|\d{4}\/\d{2}\/\d{2}/.test(label))
      : [];
  return useGuess ? [] : candidates;
}

function requestNoGuess(p: ForecastV2Payloads["decision_request"]) {
  if (p.type === "grant_date" || p.type === "grant_quantity")
    return p.noGuess ?? "지급일 후보를 아래 버튼으로 모았습니다.";
  return p.noGuess;
}

function decisionRequestBody(
  p: ForecastV2Payloads["decision_request"],
  buttons: DiscordButton[],
  context: RenderContext,
) {
  const layout = requestLayout(p);
  const noGuess = requestNoGuess(p);
  const body = renderBody(
    {
      goal: p.goal ?? GOALS[p.type],
      confirmed: p.confirmed ?? [],
      guessed: p.guessed ?? [],
      actions: layout.actions,
      rendered: layout.rendered,
      ...(legacyRequest(p) ? { legacyFormat: true } : {}),
      manualEntry: EDITABLE_REQUEST_TYPES.includes(p.type),
      ...(noGuess ? { noGuess } : {}),
      ...(layout.guess ? { guess: layout.guess } : {}),
      ...(layout.fallbackGuess.length ? { fallbackGuess: layout.fallbackGuess } : {}),
      reason: p.reason ?? DEFAULT_REASONS[p.type],
      ...(p.blocked ? { blocked: p.blocked } : {}),
      ...(p.todo ? { todo: p.todo } : {}),
    },
    {
      title: p.title,
      url: p.url,
      ...(p.postedAt ? { postedAt: p.postedAt } : {}),
      expiresAt: p.expiresAt,
    },
  );
  pushRequestButtons(p, layout, buttonPusher(buttons, context));
  return body;
}

function pushRequestButtons(
  p: ForecastV2Payloads["decision_request"],
  layout: ReturnType<typeof requestLayout>,
  push: PushButton,
) {
  if (p.type === "solo_review") {
    // bok is only admitted by permitsAction for a complete solo extraction.
    if (p.extracted?.complete === true) push(p.decisionRequestId, "bok", layout.soloConfirm);
    push(p.decisionRequestId, "bedit", "일정 수정");
    push(p.decisionRequestId, "bno", "관련 없음");
    return;
  }
  for (const option of p.options)
    push(p.decisionRequestId, "opt", optionLabel(option.label), option.id);
  if (EDITABLE_REQUEST_TYPES.includes(p.type)) push(p.decisionRequestId, "bedit", "일정 수정");
}

const CHANGE_LABELS = { added: "추가", removed: "삭제", changed: "변경" } as const;
const KIND_LABELS = {
  solo: "솔로",
  collaboration: "콜라보",
  maintenance: "점검",
  grant: "지급",
} as const;

function calendarChangedBody(p: ForecastV2Payloads["calendar_changed"], context: RenderContext) {
  const admin = new URL(p.adminUrl);
  admin.search = `?rev=${p.revision}`;
  const changes = p.changes
    .slice(0, V2_EVIDENCE_LIMITS.items)
    .map(
      (change) =>
        `• ${CHANGE_LABELS[change.change]} [${KIND_LABELS[change.kind]}] ${changeLabel(change.label)}: ${changeValue(change.before)} → ${changeValue(change.after)}`,
    );
  const body =
    `🗓 달력 변경 (rev ${p.revision})\n` +
    (changes.length ? `${changes.join("\n")}\n` : "• 의미 있는 변경 없음\n");
  const link = `\n[달력 보기](${admin.href})`;
  return cap(body, 2000 - link.length - context.idempotencyKey.length - 4) + link;
}

function reminderBody(p: ForecastV2Payloads["decision_reminder"]) {
  // Reminders repeat the stored evidence; without it nothing about the judgment is
  // known, so only the type-based goal is safe to show.
  return renderBody(
    {
      goal: p.goal ?? (p.type ? GOALS[p.type] : "결정 대기 중인 요청 확인"),
      confirmed: p.confirmed ?? [],
      guessed: p.guessed ?? [],
      ...(p.noGuess ? { noGuess: p.noGuess } : {}),
      ...(p.guess ? { guess: p.guess } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.blocked ? { blocked: p.blocked } : {}),
      // Buttons live on the original request message, not on this reminder.
      todo: p.todo ?? "원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
      ...(legacyRequest(p) ? { legacyFormat: true } : {}),
    },
    {
      title: p.title ?? "결정 대기 알림",
      ...(p.url ? { url: p.url } : {}),
      ...(p.postedAt ? { postedAt: p.postedAt } : {}),
      ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    },
  );
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
  const parsed = jsonObject(value);
  if (parsed && typeof parsed["startAt"] === "string" && typeof parsed["endAt"] === "string")
    return rangeOf(parsed["startAt"], parsed["endAt"]) ?? "일정 확인 필요";
  if (parsed && typeof parsed["gameDay"] === "string")
    return `${kstLabel(`${parsed["gameDay"]}T00:00:00+09:00`).slice(0, 8)} 관리 키트 II ${Number(parsed["ii"] ?? 0)} · 상자 ${Number(parsed["box"] ?? 0)}`;
  // A diff value that is not JSON is already a plain human label.
  return linkLabel(value);
}

/** `JSON.parse` as a typed result: null when the value is not a JSON object. */
function jsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) ? parsed : null;
  } catch (error) {
    // Only a syntax error means "not JSON"; anything else would be a real defect.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
/** Join the shared composer's inputs with this module's display formatting. */
function renderBody(
  input: ComposeInput,
  labels: {
    title: string;
    url?: string;
    postedAt?: string;
    expiresAt?: string;
  },
) {
  // The window comes from the one place the composer reads it (`input.guess`): taking it
  // from a separate label let a caller pass a guess without its formatted range, and the
  // reminder then rendered the question with no KST span.
  const range = input.guess ? rangeOf(input.guess.startAt, input.guess.endAt) : undefined;
  return compose(input, V2_EVIDENCE_LIMITS, {
    // The heading keeps a valid masked link; only its visible text is shortened.
    heading: (titleLimit, withLink) =>
      heading(
        clipTitle(labels.title, titleLimit),
        withLink ? labels.url : undefined,
        labels.postedAt,
      ),
    ...(range ? { guessRange: range } : {}),
    ...(labels.expiresAt ? { expiry: kstLabel(labels.expiresAt) } : {}),
  });
}

/** Shorten the visible title text while `manualReviewPostLink` keeps the URL intact. */
function clipTitle(title: string, limit: number) {
  // Escaping can expand text (brackets → ［］), so measure the escaped form.
  const escaped = escapeDisplay(title);
  return escaped.length <= limit
    ? title
    : title.slice(0, Math.max(1, Math.min(title.length, limit))).trimEnd();
}
