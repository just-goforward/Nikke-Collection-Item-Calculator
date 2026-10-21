// Discord embed budgeting for v2 decision messages.
//
// Pure string work: the caller supplies already-formatted heading, guess-range and
// expiry labels, plus the evidence caps, so this module never parses a payload. The
// order is fixed — evidence lists lose items ("외 N건") first, the visible title
// shrinks second, and the link is dropped only when the body still overflows — so
// 막힌 이유 / 해 주실 일 / expiry always survive.

import { linkLabel } from "./forecastManualReview.ts";
import { FALLBACK_GUIDANCE, guidance } from "./forecastV2Guidance.ts";

/** Whole embed budget: marker + escaping slack stays below Discord's 2000-char cap. */
const MESSAGE_BUDGET = 1800;
/** Smallest budget a list or title may shrink to before the loop gives up. */
const SHRINK_FLOOR = 12;
const SHRINK_STEP = 10;

/** Caps shared with the payload schema; passed in so the two cannot drift apart. */
export type EvidenceLimits = {
  goal: number;
  reason: number;
  item: number;
  items: number;
  blocked: number;
  todo: number;
};

export type ComposeInput = {
  goal: string;
  confirmed: string[];
  guessed: string[];
  /** A window the approver is asked to confirm. */
  guess?: { startAt: string; endAt: string };
  /** Visible option labels, used when no window exists but buttons do. */
  fallbackGuess?: string[];
  noGuess?: string;
  reason?: string;
  blocked?: string;
  todo?: string;
  /** This request renders [일정 수정], so direct input is a real option. */
  manualEntry?: boolean;
  /** Labels of the non-option buttons this message renders (must be offered). */
  actions?: string[];
  /** Every button label this message renders (references outside it are dropped). */
  rendered?: string[];
  /** No evidence was stored at all (rows queued before the evidence schema). */
  legacyFormat?: boolean;
};

export type ComposeLabels = {
  /** Render the heading with at most `titleLimit` visible title characters. */
  heading: (titleLimit: number, withLink: boolean) => string;
  /** The guess window, already formatted for display. */
  guessRange?: string;
  /** The expiry line's value, already formatted; rendered as `만료 …`. */
  expiry?: string;
};

export function compose(input: ComposeInput, limits: EvidenceLimits, labels: ComposeLabels) {
  const table = guidance(input.reason);
  // Escape first (display normalization), then budget (length), never the reverse: a
  // clip must not cut an escape sequence in half.
  const goal = clip(escapeDisplay(input.goal), limits.goal);
  const blocked = clip(
    escapeDisplay(input.blocked ?? fallbackBlocked(input, table)),
    limits.blocked,
  );
  // The table line is written for the buttons that reason's request renders; only an
  // unmapped reason falls back to the branch-specific default. Action references are
  // reserved before the prose is clipped, so the todo can never drop a button name.
  const todo = budgetTodo(
    input.todo ?? defaultTodo(input, table),
    input.actions,
    input.rendered,
    limits,
  );
  const lists = {
    confirmed: evidenceList(input.confirmed, limits),
    guessed: evidenceList(input.guessed, limits),
    fallbackGuess: evidenceList(input.fallbackGuess ?? [], limits),
  };
  // `noGuess` is producer prose, so it gets the same one-item bound as evidence: a
  // payload may carry many segments and none of them may displace the guidance.
  const noGuess =
    input.noGuess === undefined ? undefined : clip(escapeDisplay(input.noGuess), limits.item);
  const tail = labels.expiry ? [`만료 ${labels.expiry} KST`] : [];
  const room = MESSAGE_BUDGET - tail.join("\n").length - 1;
  let body = fitted(input, limits, labels, lists, noGuess, goal, blocked, todo, room, true);
  // A notice URL longer than the leftover budget must never push the reason, the
  // guidance or the expiry out of the message: the heading text still names the post.
  if (body.length > room)
    body = fitted(input, limits, labels, lists, noGuess, goal, blocked, todo, room, false);
  return [body, ...tail].join("\n");
}

/** The reason table's blocked line, or the legacy/branch fallback when unmapped. */
function fallbackBlocked(input: ComposeInput, table: ReturnType<typeof guidance>) {
  if (input.legacyFormat) return "이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다";
  return (table ?? FALLBACK_GUIDANCE)[0];
}

function defaultTodo(input: ComposeInput, table: ReturnType<typeof guidance>) {
  const fallback = input.manualEntry
    ? "공지 원문을 확인해 맞으면 [일정 수정]으로 시작·종료를 직접 입력하고, 무관하면 [관련 없음]을 눌러 주세요."
    : "원래 결정 요청 메시지에서 맞는 버튼을 눌러 주세요.";
  return table?.[1] ?? fallback;
}

type Lists = {
  confirmed: { items: string[]; dropped: number };
  guessed: { items: string[]; dropped: number };
  fallbackGuess: { items: string[]; dropped: number };
};

/**
 * Shrink the evidence lists, then the visible title (and only then drop the link),
 * until the body fits `room`.
 */
function fitted(
  input: ComposeInput,
  limits: EvidenceLimits,
  labels: ComposeLabels,
  lists: Lists,
  noGuess: string | undefined,
  goal: string,
  blocked: string,
  todo: string,
  room: number,
  withLink: boolean,
) {
  const parts = { input, labels, lists, noGuess, goal, blocked, todo };
  let titleLimit = limits.goal + 80;
  let itemLimit = limits.item * limits.items;
  while (sections(parts, itemLimit, titleLimit, withLink).length > room) {
    if (itemLimit > SHRINK_FLOOR) itemLimit -= SHRINK_STEP;
    else if (titleLimit > SHRINK_FLOOR) titleLimit -= SHRINK_STEP;
    else break;
  }
  return sections(parts, itemLimit, titleLimit, withLink);
}

/** The body as one string: fixed sections first, evidence lines in the middle. */
function sections(
  parts: {
    input: ComposeInput;
    labels: ComposeLabels;
    lists: Lists;
    noGuess: string | undefined;
    goal: string;
    blocked: string;
    todo: string;
  },
  itemLimit: number,
  titleLimit: number,
  withLink: boolean,
): string {
  const { input, labels, lists } = parts;
  return [
    labels.heading(titleLimit, withLink),
    `하려던 일: ${parts.goal}`,
    confirmedLine(input, lists.confirmed, itemLimit),
    guessLine(input, labels, lists, parts.noGuess, itemLimit),
    `❌ 막힌 이유: ${parts.blocked}`,
    `👉 해 주실 일: ${parts.todo}`,
  ].join("\n");
}

function confirmedLine(input: ComposeInput, confirmed: Lists["confirmed"], itemLimit: number) {
  if (confirmed.items.length) return `✅ 확인한 것: ${listLine(confirmed, itemLimit)}`;
  // Legacy rows store no facts, so the fallbacks must not invent them.
  return input.legacyFormat
    ? "✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다"
    : "✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다";
}

function guessLine(
  input: ComposeInput,
  labels: ComposeLabels,
  lists: Lists,
  noGuess: string | undefined,
  itemLimit: number,
) {
  if (labels.guessRange) return `🤔 추측한 것: 이 일정(${labels.guessRange})으로 하면 될까요?`;
  if (input.guess) return "🤔 추측한 것: 이 일정으로 하면 될까요? (공지에서 추출한 시작·종료)";
  if (lists.guessed.items.length)
    return `🤔 추측한 것: 읽은 후보 ${listLine(lists.guessed, itemLimit)}`;
  if (noGuess) return `🤔 추측한 것: ${noGuess}`;
  if (lists.fallbackGuess.items.length)
    return `🤔 추측한 것: 읽은 후보 ${listLine(lists.fallbackGuess, itemLimit)}`;
  return emptyGuessed(input);
}

function emptyGuessed(input: ComposeInput) {
  if (input.legacyFormat)
    return "🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다";
  if (input.manualEntry)
    return "🤔 추측한 것: 일정을 확인하지 못했습니다. [일정 수정]으로 직접 입력해 주세요.";
  return "🤔 추측한 것: 일정을 확인하지 못했습니다. 원래 결정 요청 메시지의 버튼을 눌러 주세요.";
}

/**
 * Escape, drop references to buttons this message lacks, append missing action buttons,
 * then clip the prose around them: action references are reserved and never cut.
 */
function budgetTodo(
  todo: string,
  actions: readonly string[] | undefined,
  rendered: readonly string[] | undefined,
  limits: EvidenceLimits,
) {
  const limit = limits.todo;
  let text = dropMissingReferences(todo, rendered);
  if (actions) text = appendMissingActions(text, actions);
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

/** A todo may only name buttons this message actually renders. */
function dropMissingReferences(todo: string, rendered: readonly string[] | undefined) {
  if (!rendered) return todo;
  let text = todo;
  for (const reference of new Set(text.match(/\[[^\]]+\]/g) ?? []))
    if (!rendered.some((label) => reference === `[${label}]`))
      text = text.replaceAll(reference, "");
  return text;
}

/** Every action button must be named, so append the ones the prose omitted. */
function appendMissingActions(text: string, actions: readonly string[]) {
  const missing = actions.filter((label) => !text.includes(`[${label}]`));
  if (!missing.length) return text;
  const separator = text.endsWith(".") ? "" : ".";
  const labels = missing.map((label) => `[${label}]`).join(", ");
  return `${text.replace(/[,\s]+$/, "")}${separator} 그 밖에 ${labels} 버튼도 있습니다.`;
}

export function listLine(list: { items: string[]; dropped: number }, limit: number) {
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
function evidenceList(values: readonly string[], limits: EvidenceLimits) {
  const items = values
    .map((value) => evidenceText(value, limits))
    .filter((item) => item.length > 0);
  const kept = items.slice(0, limits.items);
  return { items: kept, dropped: items.length - kept.length };
}

function evidenceText(value: string, limits: EvidenceLimits) {
  return clip(escapeDisplay(value), limits.item);
}

/** Display normalization only: no markdown, links or mention tokens, one line. */
export function escapeDisplay(value: string) {
  // Same escaping as titles; one line only so sections cannot be forged.
  // linkLabel backslash-escapes "~" because it builds link labels; in an embed a lone
  // "~" is harmless and ranges read better unescaped, while "~~" (strikethrough) stays
  // neutralised as full-width tildes.
  return linkLabel(value.replace(/[\r\n]+/g, " ").trim())
    .replace(/\\~\\~/g, "～～")
    .replace(/\\~/g, "~");
}

/** Length budgeting only, applied after escaping so no escape pair is split. */
export function clip(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
