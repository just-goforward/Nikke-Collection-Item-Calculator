import { manualReviewReason } from "../../shared/forecastManualReview.ts";

export type ReviewEvidence = {
  block_index: number;
  judged_at: string;
  reason: string | null;
  question: string;
  triggers_json: string;
  block_excerpt: string;
  comparison_json: string;
  expires_at: string | null;
};

const MAINTENANCE_ACTION =
  "board-48 업데이트 공지의 점검 일시를 확인하세요. 공지가 게시되면 [재처리], 기간이 기존 일정과 같으면 [관련 없음]을 누르세요.";
const UNSUPPORTED_ACTION =
  "재오픈/중단은 아직 자동 반영하지 않습니다. 공지 내용(기간·중단 시각)을 확인한 뒤, 예보에 반영할 필요가 없으면 [관련 없음], 공지가 수정됐으면 [재처리]를 누르세요.";
const GUIDANCE: Record<string, [string, string]> = {
  ambiguous_schedule_change: [
    "공지의 기간이 기존 일정의 반복 안내인지 실제 변경인지 구분하지 못했습니다.",
    "위 기간이 맞고 솔로 레이드 중단·연장·재개 내용이 없다면 → [관련 없음]; 일정이 바뀌었다면 → [일정 직접 확정]",
  ],
  maintenance_missing: [
    "점검 종료 시각을 찾지 못해 솔로 레이드 시작 시각을 확정하지 못했습니다.",
    MAINTENANCE_ACTION,
  ],
  maintenance_conflict: [
    "점검 시각이 여러 개여서 적용할 종료 시각을 확정하지 못했습니다.",
    MAINTENANCE_ACTION,
  ],
  maintenance_crosses_day: [
    "점검이 날짜를 넘어가므로 레이드 시작 날짜를 확정하지 못했습니다.",
    MAINTENANCE_ACTION,
  ],
  schedule_conflict: [
    "서로 충돌하는 기간이 있어 최종 레이드 일정을 고르지 못했습니다.",
    "옛 값·수정 값과 공식 후속 공지를 대조해 최종 시작·종료 시각을 확인한 뒤 → [일정 직접 확정]",
  ],
  suspension_unsupported: [
    "중단 안내는 자동 일정 처리로 안전하게 반영할 수 없습니다.",
    UNSUPPORTED_ACTION,
  ],
  reopen_unsupported: [
    "재개 안내는 자동 일정 처리로 안전하게 반영할 수 없습니다.",
    UNSUPPORTED_ACTION,
  ],
  schedule_change_in_section: [
    "본문 일부에 일정 변경 표현이 있어 전체 기간만으로 판단하지 못했습니다.",
    "솔로 레이드 항목에 연장·일정 변경 문구가 있습니다. 공지의 새 기간을 확인하고, 단순 연장/변경이면 [일정 직접 확정]으로 새 기간 입력, 반영할 필요가 없으면 [관련 없음].",
  ],
  not_official_manager: [
    "공식 운영자 게시물인지 확인하지 못했습니다.",
    "작성자와 공식 공지 원문을 확인하세요. 비공식·무관한 글이면 → [관련 없음]; 공식 일정이 확인되면 → [일정 직접 확정]",
  ],
  unstructured_body: [
    "공지 본문 형식을 읽지 못해 기간과 변경 내용을 확인하지 못했습니다.",
    "원문·첨부 이미지의 레이드 기간과 수정 내용을 확인하세요. 일정이 확인되면 → [일정 직접 확정]; 무관하면 → [관련 없음]; 본문 복구 후 → [재처리]",
  ],
};

export function truncateReview(value: string, limit: number) {
  const suffix = "…(생략)";
  return value.length <= limit ? value : value.slice(0, limit - suffix.length) + suffix;
}

/** Escape input backslashes before adding Markdown escapes; keep single range tildes. */
export function escapeReviewText(value: string) {
  const replacements: Record<string, string> = {
    "<": "＜",
    ">": "＞",
    "@": "＠",
    "[": "［",
    "]": "］",
  };
  return value
    .replace(/[\\|`*_]/g, "\\$&")
    .replace(/~{2,}/g, (run) => run.replaceAll("~", "\\~"))
    .replace(/[<>@[\]]/g, (character) => replacements[character] ?? character);
}

export function reviewKst(value: string) {
  const date = new Date(Date.parse(value) + 9 * 60 * 60 * 1000);
  if (!Number.isFinite(date.getTime())) return "시각 확인 필요";
  return `${date.toISOString().slice(0, 10)} (${"일월화수목금토"[date.getUTCDay()]}) ${date.toISOString().slice(11, 16)} KST`;
}

type Schedule = {
  startsAt?: string | null;
  endsAt?: string | null;
  startKst?: string;
  endKst?: string;
};

function quoteText(text: string) {
  return text
    .split(/(~~[\s\S]*?~~)/g)
    .map((part) =>
      part.startsWith("~~") && part.endsWith("~~")
        ? `[옛 값(취소선): ${escapeReviewText(part.slice(2, -2))}]`
        : escapeReviewText(part),
    )
    .join("")
    .replace(/^/gm, "> ");
}

function scheduleText(schedule: Schedule | null) {
  if (!schedule) return "확인 불가";
  const start = schedule.startKst ?? (schedule.startsAt ? reviewKst(schedule.startsAt) : "미확정");
  const end = schedule.endKst ?? (schedule.endsAt ? reviewKst(schedule.endsAt) : "미확정");
  return `${escapeReviewText(start)} ~ ${escapeReviewText(end)} (KST)`;
}

export function reviewEvidenceFields(rows: ReviewEvidence[]) {
  return rows.slice(0, 3).flatMap((row) => {
    const code = row.reason ?? "unknown";
    const knownCode = Object.hasOwn(GUIDANCE, code);
    const [reason, action] = (knownCode ? GUIDANCE[code] : undefined) ?? [
      manualReviewReason("unknown"),
      "원문의 레이드 기간과 변경 여부를 확인하세요. 무관하면 → [관련 없음]; 일정 변경이면 → [일정 직접 확정]",
    ];
    const triggers = JSON.parse(row.triggers_json) as string[];
    const comparison = JSON.parse(row.comparison_json) as {
      known: Schedule | null;
      extracted: Schedule | null;
      equal: boolean;
    };
    const quotes = [...triggers.slice(0, 5), row.block_excerpt].map(quoteText).join("\n");
    const values: [string, string, number][] = [
      ["🤖 확인하려던 것", escapeReviewText(row.question), 140],
      ["❓ 막힌 이유", `${reason}${knownCode ? `\n-# 사유 코드: \`${code}\`` : ""}`, 200],
      ["🔎 근거 인용", quotes, 500],
      [
        "📅 기존 일정 비교",
        `기존: ${scheduleText(comparison.known)}\n추출: ${scheduleText(comparison.extracted)}\n${!comparison.known ? "기존 일정 없음" : comparison.equal ? "✅ 같음" : "⚠️ 다름"}`,
        260,
      ],
      ["✅ 해야 할 일", action, 260],
    ];
    // <=4080 values + 675 names + 400 description + 250 footer + title: <5500.
    return values.map(([name, value, limit]) => ({
      name: truncateReview(`${name} · ${row.block_index + 1}`, 45),
      value: truncateReview(value, limit) || "확인 필요",
      inline: false,
    }));
  });
}
