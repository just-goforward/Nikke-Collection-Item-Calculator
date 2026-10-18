import {
  addGameDays,
  calendarRange,
  gameDay,
} from "../../forecast-collector/src/v2/rules/game-day.ts";
import type { ActiveCalendar, CalendarEvent, EventKind, EventStatus } from "./calendar.ts";
import { html, SafeHtml } from "./html.ts";

/** Inline stylesheet; the CSP admits exactly this text by hash. No script is ever emitted. */
export const STYLE = `:root{color-scheme:light;--ink:#1d1d24;--muted:#555561;--line:#d4d4dc;--solo:#5b2fd6;--collaboration:#a84300;--maintenance:#37474f;--coop:#0d47a1;--grant:#00695c;--note:#5f5f6b}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 "Pretendard","Malgun Gothic",system-ui,sans-serif;color:var(--ink);background:#f6f6f9}
header,main{padding:16px;max-width:1180px;margin:0 auto}
h1{font-size:1.3rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px}h3{font-size:.95rem;margin:0 0 4px}
.sub{color:var(--muted);margin:0}
.notice{border:2px solid #8a5a00;background:#fff8e1;padding:8px 12px;border-radius:6px;margin:12px 0}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;padding:0;margin:12px 0;list-style:none}
.legend li{font-size:.85rem}
.dow-head{display:none}
ol.days{list-style:none;margin:0;padding:0}
ol.days>li{background:#fff;border:1px solid var(--line);border-radius:6px;padding:8px;margin:0 0 8px;overflow-wrap:anywhere;scroll-margin-top:12px}
ol.days>li[aria-current=date]{border:2px solid var(--ink)}
ol.days>li:target{outline:3px solid #1a56db;outline-offset:2px}
.today{font-size:.75rem;background:var(--ink);color:#fff;border-radius:3px;padding:0 4px;margin-left:4px}
.evs{list-style:none;margin:0;padding:0}
.ev{margin:3px 0;padding:2px 6px;border:1px solid transparent;border-left:4px solid var(--k);border-radius:3px;font-size:.85rem}
.badge{font-weight:700}
.k-solo{--k:var(--solo)}.k-collaboration{--k:var(--collaboration)}.k-maintenance{--k:var(--maintenance)}.k-coop{--k:var(--coop)}.k-grant{--k:var(--grant)}.k-note{--k:var(--note)}
.st-confirmed{background:#ecebf7}
.st-predicted{background:repeating-linear-gradient(45deg,#ece6ff 0 6px,#fff 6px 12px)}
.st-alt{background:repeating-linear-gradient(-45deg,#f3f0ff 0 3px,#fff 3px 9px);border-left-style:dotted}
.st-pending,.st-notice{border:1px dashed #6b6b76;border-left:4px dashed var(--k);background:#fff}
.st-cancelled{background:#f1f1f4;color:#4a4a55;text-decoration:line-through}
.st-info{background:#f4f6fb}
.kits{font-size:.85rem;margin:6px 0 0;font-weight:600}
.missing{color:var(--muted);font-size:.85rem;margin:0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;background:#fff;border:1px solid var(--line);font-size:.9rem;width:100%}
th,td{border-bottom:1px solid #e4e4ea;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f4f4f8}td.num,th.num{text-align:right}
@media (min-width:640px){.dow-head{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;text-align:center;color:var(--muted);font-size:.8rem;margin:0 0 4px}
ol.days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
ol.days>li{margin:0;min-height:112px;padding:4px 5px}
.start-1{grid-column-start:2}.start-2{grid-column-start:3}.start-3{grid-column-start:4}.start-4{grid-column-start:5}.start-5{grid-column-start:6}.start-6{grid-column-start:7}}`;
// STYLE is a source constant (no `<`), emitted verbatim so the CSP hash matches.
const TRUSTED_STYLE = new SafeHtml(STYLE);

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
const KIND_LABEL: Record<EventKind, string> = {
  solo: "솔로 레이드",
  collaboration: "콜라보",
  maintenance: "점검",
};
const STATUS_LABEL: Record<EventStatus, string> = {
  confirmed: "확정",
  predicted: "예측",
  pending: "공지 대기",
  cancelled: "취소됨",
};
const KIND_ORDER: Record<EventKind, number> = { maintenance: 0, solo: 1, collaboration: 2 };
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

const pad = (value: number) => String(value).padStart(2, "0");
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Korean wall-clock text in KST, independent of the server or browser time zone. */
function formatKst(instant: string): string {
  const date = new Date(Date.parse(instant) + KST_MS);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}(${WEEKDAYS[date.getUTCDay()]}) ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatDay(day: string): string {
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} (${WEEKDAYS[weekday(day)]})`;
}

function eventName(event: CalendarEvent) {
  return event.title ?? KIND_LABEL[event.kind];
}

function eventItem(event: CalendarEvent, day: string): SafeHtml {
  const details: string[] = [];
  if (event.kind !== "maintenance" && event.startGameDay && day >= event.startGameDay)
    details.push(`${dayDiff(event.startGameDay, day) + 1}일차`);
  if (day === event.startGameDay || (!event.startGameDay && event.startsAt === null))
    details.push(
      event.startsAt
        ? `${formatKst(event.startsAt)} 시작`
        : event.afterMaintenance
          ? "점검 완료 후 시작"
          : "시작 시각 미정",
    );
  if (day === event.endGameDay && event.endsAt) details.push(`${formatKst(event.endsAt)} 종료`);
  return html`<li class="ev k-${event.kind} st-${event.status}"><span class="badge">${STATUS_LABEL[event.status]}</span> · ${KIND_LABEL[event.kind]} · ${eventName(event)}${details.map((detail) => ` · ${detail}`).join("")}</li>`;
}

type Extra = { kind: "alt" | "notice"; event: CalendarEvent; at: string; interval?: number };

function predictionExtras(events: Iterable<CalendarEvent>) {
  const extras = new Map<string, Extra[]>();
  const add = (extra: Extra) => {
    const day = gameDay(extra.at);
    extras.set(day, [...(extras.get(day) ?? []), extra]);
  };
  for (const event of events) {
    const provenance = event.provenance;
    if (event.status !== "predicted" || !provenance) continue;
    if (provenance.alternativeStartsAt)
      add({
        kind: "alt",
        event,
        at: provenance.alternativeStartsAt,
        ...(provenance.alternativeIntervalDays
          ? { interval: provenance.alternativeIntervalDays }
          : {}),
      });
    if (provenance.expectedNoticeAt)
      add({ kind: "notice", event, at: provenance.expectedNoticeAt });
  }
  return extras;
}

function extraItem(extra: Extra): SafeHtml {
  const name = eventName(extra.event);
  if (extra.kind === "alt")
    return html`<li class="ev k-${extra.event.kind} st-alt"><span class="badge">차순위 예측</span> · ${name}${extra.interval ? ` (${extra.interval}일 간격)` : ""} · ${formatKst(extra.at)} 시작</li>`;
  return html`<li class="ev k-note st-notice"><span class="badge">예상 공지 시점</span> · ${name} 오픈 공지 · ${formatKst(extra.at)} (예측)</li>`;
}

function provenanceText(event: CalendarEvent): string {
  const parts: string[] = [];
  const provenance = event.provenance;
  if (provenance?.intervalDays) parts.push(`시작 간격 중앙값 ${provenance.intervalDays}일`);
  if (provenance?.alternativeStartsAt)
    parts.push(
      `차순위${provenance.alternativeIntervalDays ? ` ${provenance.alternativeIntervalDays}일 간격` : ""}: ${formatKst(provenance.alternativeStartsAt)} 시작`,
    );
  if (provenance?.expectedNoticeAt)
    parts.push(`예상 공지 시점 ${formatKst(provenance.expectedNoticeAt)}`);
  if (event.afterMaintenance) parts.push("점검 완료 후 시작(점검 일정 기준)");
  return parts.join(" · ") || "—";
}

function documentShell(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title}</title><style>${TRUSTED_STYLE}</style></head>
<body>${body}</body></html>`.value;
}

export function renderMessagePage(title: string, message: string): string {
  return documentShell(
    `${title} · 운영 달력`,
    html`<main><h1>${title}</h1><p>${message}</p></main>`,
  );
}

export function renderCalendarPage(input: {
  calendar: ActiveCalendar | null;
  nowMs: number;
  requestedRevision: number | null;
}): string {
  const range = calendarRange(input.nowMs);
  const today = range.start;
  const heading = `운영 달력 (${range.start} ~ ${range.end})`;
  const sub = html`<p class="sub">게임일 기준(05:00 ~ 다음 날 04:59:59) · 모든 시각은 한국 시각(KST) · 읽기 전용</p>`;
  const calendar = input.calendar;
  if (!calendar)
    return documentShell(
      heading,
      html`<header><h1>${heading}</h1>${sub}</header><main><p class="notice">활성 달력이 아직 없습니다. 수집기가 첫 달력을 만들면 여기에 표시됩니다.</p></main>`,
    );

  const days: string[] = [];
  for (let day = range.start; day <= range.end; day = addGameDays(day, 1)) days.push(day);
  const notices: SafeHtml[] = [];
  if (input.requestedRevision !== null && input.requestedRevision < calendar.version)
    notices.push(
      html`<p class="notice" role="status"><strong>이 링크 이후 갱신됨</strong> · 링크 개정 ${input.requestedRevision}, 현재 개정 ${calendar.version}. 아래는 최신 달력입니다.</p>`,
    );
  if (calendar.rangeStart !== range.start || calendar.rangeEnd < range.end)
    notices.push(
      html`<p class="notice"><strong>달력이 오늘 기준으로 갱신되지 않았습니다.</strong> 저장된 범위 ${calendar.rangeStart} ~ ${calendar.rangeEnd} (생성 ${formatKst(calendar.createdAt)} KST). 자료가 없는 날짜는 비어 있다고 표시합니다.</p>`,
    );

  const extras = predictionExtras(calendar.events.values());
  const shownEvents = new Map<string, CalendarEvent>();
  const pendingItems: SafeHtml[] = [];
  let coopII = 0;
  let grantII = 0;
  let grantBox = 0;
  let totalII = 0;
  let totalBox = 0;
  const dayItems = days.map((day, index) => {
    const data = calendar.days.get(day);
    const isToday = day === today;
    const items: SafeHtml[] = [];
    if (data) {
      const events = data.eventIds
        .map((id) => calendar.events.get(id))
        .filter((event): event is CalendarEvent => event !== undefined)
        .sort(
          (a, b) =>
            KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
            (a.startsAt ?? "").localeCompare(b.startsAt ?? "") ||
            a.eventId.localeCompare(b.eventId),
        );
      for (const event of events) {
        shownEvents.set(event.eventId, event);
        items.push(eventItem(event, day));
      }
      for (const extra of extras.get(day) ?? []) items.push(extraItem(extra));
      if (data.coop)
        items.push(
          html`<li class="ev k-coop st-info"><span class="badge">협동작전 상점</span> · 관리 키트 상자 II ×${data.coop}${data.coop === 10 ? " (콜라보 기간 2배)" : ""}</li>`,
        );
      for (const grant of data.grants) {
        grantII += grant.ii;
        grantBox += grant.box;
        items.push(
          html`<li class="ev k-grant st-info"><span class="badge">공지 보상</span> · ${grant.label} · 상자 II ${grant.ii} · 상자 ${grant.box}</li>`,
        );
      }
      for (const note of data.pending) {
        pendingItems.push(html`<li><a href="#gd-${day}">${formatDay(day)}</a> · ${note}</li>`);
        items.push(
          html`<li class="ev k-note st-pending"><span class="badge">결정 대기</span> · ${note}</li>`,
        );
      }
      coopII += data.coop;
      totalII += data.kits.ii;
      totalBox += data.kits.box;
    } else {
      for (const extra of extras.get(day) ?? []) items.push(extraItem(extra));
    }
    const kits =
      data && (data.kits.ii || data.kits.box)
        ? html`<p class="kits">관리 키트 합계: 상자 II ${data.kits.ii} · 상자 ${data.kits.box}</p>`
        : "";
    return html`<li id="gd-${day}" class="${index === 0 ? `start-${weekday(day)}` : ""}"${isToday ? html` aria-current="date"` : ""}><h3><time datetime="${day}">${formatDay(day)}</time>${isToday ? html`<span class="today">오늘</span>` : ""}</h3>${data ? "" : html`<p class="missing">이 날짜의 달력 자료가 없습니다.</p>`}${items.length ? html`<ul class="evs">${items}</ul>` : ""}${kits}</li>`;
  });
  for (const event of shownEvents.values())
    if (event.status === "pending")
      pendingItems.push(
        html`<li>${KIND_LABEL[event.kind]} · ${eventName(event)} · 공지 대기 (예측 일정이 지났거나 공지가 아직 없음)</li>`,
      );

  const eventRows = [...shownEvents.values()]
    .sort((a, b) => (a.startsAt ?? "~").localeCompare(b.startsAt ?? "~"))
    .map(
      (event) =>
        html`<tr><td>${KIND_LABEL[event.kind]}</td><td>${eventName(event)}</td><td>${STATUS_LABEL[event.status]}</td><td>${event.startsAt ? formatKst(event.startsAt) : event.afterMaintenance ? "점검 완료 후" : "미정"} ~ ${event.endsAt ? formatKst(event.endsAt) : "미정"}</td><td>${provenanceText(event)}</td></tr>`,
    );

  const body = html`<header><h1>${heading}</h1>${sub}<p class="sub">달력 개정 ${calendar.version} · 생성 ${formatKst(calendar.createdAt)} KST</p>${notices}
<ul class="legend" aria-label="표시 방법"><li><span class="badge">확정</span>: 공지로 확정(채움)</li><li><span class="badge">예측</span>: 간격 중앙값 예측(빗금)</li><li><span class="badge">차순위 예측</span>: 두 번째로 잦은 간격(점선)</li><li><span class="badge">공지 대기·예상 공지 시점·결정 대기</span>: 미확정(파선 테두리)</li><li><span class="badge">취소됨</span>: 취소선</li></ul></header>
<main><h2 id="days-heading">날짜별 일정</h2><div class="dow-head" aria-hidden="true">${WEEKDAYS.map((name) => html`<span>${name}</span>`)}</div>
<ol class="days" aria-labelledby="days-heading">${dayItems}</ol>
<h2>기간 합계 (${range.start} ~ ${range.end} 게임일)</h2>
<div class="scroll" role="region" aria-label="기간 합계 표" tabindex="0"><table><thead><tr><th scope="col">수급원</th><th scope="col" class="num">상자 II</th><th scope="col" class="num">상자</th></tr></thead><tbody>
<tr><td>협동작전 상점</td><td class="num">${coopII}</td><td class="num">0</td></tr>
<tr><td>공지 보상</td><td class="num">${grantII}</td><td class="num">${grantBox}</td></tr>
<tr><th scope="row">날짜별 합계의 합</th><td class="num">${totalII}</td><td class="num">${totalBox}</td></tr></tbody></table></div>
<h2>일정 목록</h2>${
    eventRows.length
      ? html`<div class="scroll" role="region" aria-label="일정 목록 표" tabindex="0"><table><thead><tr><th scope="col">종류</th><th scope="col">이름</th><th scope="col">상태</th><th scope="col">기간 (KST)</th><th scope="col">근거</th></tr></thead><tbody>${eventRows}</tbody></table></div>`
      : html`<p>이 기간에 표시할 일정이 없습니다.</p>`
  }
<h2>결정·공지 대기</h2>${pendingItems.length ? html`<ul>${pendingItems}</ul>` : html`<p>대기 중인 결정이 없습니다.</p>`}</main>`;
  return documentShell(heading, body);
}
