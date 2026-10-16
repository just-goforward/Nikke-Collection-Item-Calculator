// Discord presentation shared by the dispatcher (initial message) and the
// interactions router (confirm / cancel / outcome). Display only: no I/O.

export const MANUAL_REVIEW_WORKFLOW_URL =
  "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/workflows/resolve-forecast-manual-review.yml";

export type ManualEnvironment = "staging" | "production";
export type ManualDecision = "requeue" | "ignore";

export const MANUAL_DECISION_LABELS: Record<ManualDecision, string> = {
  requeue: "재처리",
  ignore: "관련 없음",
};

const REASONS: Record<string, string> = {
  ambiguous_schedule_change: "공지에서 일정 변경 여부를 자동으로 판단하지 못했습니다.",
  unstructured_body: "공지 본문 형식을 자동으로 읽지 못했습니다.",
  not_official_manager: "공식 운영자 게시물인지 확인하지 못했습니다.",
  naver_redirect: "공지 주소가 다른 곳으로 이동되었습니다(삭제·이동 가능성).",
  naver_content_type: "네이버가 예상과 다른 형식으로 응답했습니다.",
  naver_malformed_json: "네이버 응답을 해석하지 못했습니다.",
  naver_response_too_large: "공지 본문이 허용 크기를 넘었습니다.",
  naver_response_oversize: "공지 본문이 허용 크기를 넘었습니다.",
  naver_detail_url_mismatch: "공지 주소가 목록과 일치하지 않습니다.",
  naver_detail_identity: "공지 게시판·번호가 목록과 일치하지 않습니다.",
  naver_date: "공지 날짜를 해석하지 못했습니다.",
  naver_item_id: "공지 번호가 올바르지 않습니다.",
  runtime_ingestion_source_conflict: "이미 등록된 일정과 내용이 충돌합니다.",
};

/** Plain-Korean reason; the raw code is kept only as secondary text. */
export function manualReviewReason(code: string): string {
  if (REASONS[code]) return REASONS[code];
  if (/^naver_detail_schema_/.test(code)) return "공지 본문 구조가 예상과 다릅니다.";
  if (/^naver_(http_5\d\d|timeout|network|http_429)$/.test(code))
    return "네이버 응답이 반복해서 실패했습니다.";
  if (/^naver_http_4\d\d$/.test(code)) return "공지를 열 수 없습니다(삭제·비공개 가능성).";
  return "자동 처리에 실패해 사람의 확인이 필요합니다.";
}

function escapeMarkdown(value: string) {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>@<~]/g, "\\$&");
}

function naverUrl(value: string) {
  const url = URL.parse(value);
  // ")" would end the masked link early; encode it (and "(") for Discord.
  return url?.protocol === "https:" && url.hostname === "game.naver.com"
    ? url.toString().replaceAll("(", "%28").replaceAll(")", "%29")
    : "https://game.naver.com/lounge/nikke/home";
}

/** Markdown link for an already display-normalized, length-bounded title. */
export function manualReviewPostLink(title: string, url: string) {
  return `[${escapeMarkdown(title)}](${naverUrl(url)})`;
}

type Button =
  | { type: 2; style: 1 | 2 | 3 | 4; custom_id: string; label: string; disabled?: boolean }
  | { type: 2; style: 5; label: string; url: string; disabled?: boolean };

function row(components: Button[]) {
  return [{ type: 1, components }];
}

const directLink: Button = {
  type: 2,
  style: 5,
  label: "일정 직접 확정",
  url: MANUAL_REVIEW_WORKFLOW_URL,
};

export function manualReviewButtons(environment: ManualEnvironment, reviewId: string) {
  return row([
    {
      type: 2,
      style: 1,
      custom_id: `forecast_manual_${environment}_requeue:${reviewId}`,
      label: MANUAL_DECISION_LABELS.requeue,
    },
    {
      type: 2,
      style: 2,
      custom_id: `forecast_manual_${environment}_ignore:${reviewId}`,
      label: MANUAL_DECISION_LABELS.ignore,
    },
    directLink,
  ]);
}

export function manualConfirmButtons(
  environment: ManualEnvironment,
  decision: ManualDecision,
  reviewId: string,
) {
  return row([
    {
      type: 2,
      style: decision === "ignore" ? 4 : 3,
      custom_id: `forecast_manual_${environment}_${decision}_confirm:${reviewId}`,
      label: `확인: ${MANUAL_DECISION_LABELS[decision]}`,
    },
    {
      type: 2,
      style: 2,
      custom_id: `forecast_manual_${environment}_cancel:${reviewId}`,
      label: "취소",
    },
  ]);
}

export function manualDoneButtons(label: string) {
  return row([{ type: 2, style: 2, custom_id: "forecast_manual_done", label, disabled: true }]);
}
