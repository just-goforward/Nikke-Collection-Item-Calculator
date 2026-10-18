import { linkLabel, manualReviewPostLink } from "./forecastManualReview.ts";

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
    extracted?: { complete: boolean };
  };
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
  decision_reminder: { decisionRequestId: string };
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
export function validateForecastV2Payload<K extends ForecastV2NotificationKind>(
  kind: K,
  v: unknown,
): v is ForecastV2Payloads[K] {
  if (!record(v)) return false;
  if (kind === "calendar_changed") return validateCalendarChanged(v);
  if (!id(v["decisionRequestId"])) return false;
  if (kind === "decision_reminder") return true;
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
    new Set(v["options"].map((o) => o.id)).size === v["options"].length
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
    )
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
      label: linkLabel(label).slice(0, 80),
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
    const labels = {
      open: "시작",
      suspend: "중단",
      resume: "재개",
      extend: "연장",
      reopen: "재오픈",
      close: "종료",
    };
    body =
      `일정 변경 검토\n${manualReviewPostLink(p.title, p.url)}\n게시: ${linkLabel(p.postedAt)}\n` +
      p.extracted.segments
        .map(
          (s) =>
            `${labels[s.kind]}: ${linkLabel(s.startAt ?? "미확정")} → ${linkLabel(s.endAt ?? "미확정")}`,
        )
        .join("\n") +
      "\n" +
      p.extracted.kits
        .map((k) => `${linkLabel(k.gameDay)}: 관리 키트 II ${k.ii}, 상자 ${k.box}`)
        .join("\n");
    if (p.extracted.complete === true) button(p.decisionRequestId, "bok", "확정");
    button(p.decisionRequestId, "bedit", "일정 수정");
    button(p.decisionRequestId, "bno", "관련 없음");
  } else if (kind === "decision_request") {
    const p = input as ForecastV2Payloads["decision_request"];
    body = `결정 요청\n${manualReviewPostLink(p.title, p.url)}\n만료: ${linkLabel(p.expiresAt)}`;
    if (p.type === "solo_review") {
      if (p.extracted?.complete === true) button(p.decisionRequestId, "bok", "확정");
      button(p.decisionRequestId, "bedit", "일정 수정");
      button(p.decisionRequestId, "bno", "관련 없음");
    } else {
      for (const o of p.options) button(p.decisionRequestId, "opt", o.label, o.id);
      if (["collaboration", "maintenance"].includes(p.type))
        button(p.decisionRequestId, "bedit", "일정 수정");
    }
  } else if (kind === "calendar_changed") {
    const p = input as ForecastV2Payloads["calendar_changed"];
    const admin = new URL(p.adminUrl);
    admin.search = `?rev=${p.revision}`;
    body =
      "달력 변경\n" +
      p.changes
        .map(
          (c) =>
            `${linkLabel(c.label)} (${{ added: "추가", removed: "삭제", changed: "변경" }[c.change]}): ${linkLabel(c.before ?? "없음")} → ${linkLabel(c.after ?? "없음")}`,
        )
        .join("\n");
    const link = `\n[달력 보기](${admin.href})`;
    body = cap(body, 2000 - link.length - context.idempotencyKey.length - 4) + link;
  } else {
    body = `결정 대기 알림\n요청: ${linkLabel((input as ForecastV2Payloads["decision_reminder"]).decisionRequestId)}\n기존 결정 요청 메시지에서 확인해 주세요.`;
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
function cap(value: string, limit: number) {
  return value.length <= limit ? value : value.slice(0, limit - 5) + "…(생략)";
}
