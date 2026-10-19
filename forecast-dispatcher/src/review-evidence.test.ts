import { describe, expect, it } from "vitest";
import { opsAlertMessage } from "./discord";
import { escapeReviewText, type ReviewEvidence, reviewEvidenceFields } from "./review-evidence";
import type { OpsAlertRow } from "./types";

const row: ReviewEvidence = {
  block_index: 0,
  judged_at: "2026-10-17T00:07:00Z",
  reason: "ambiguous_schedule_change",
  question: "솔로 레이드 기간이 기존 일정과 같은가?",
  triggers_json: JSON.stringify(["솔로 레이드: 10월 22일 ~ 10월 29일"]),
  block_excerpt: "솔로 레이드: 10월 22일 ~ 10월 29일",
  comparison_json: JSON.stringify({
    known: { startKst: "2026-10-22 05:00", endKst: "2026-10-29 04:59" },
    extracted: { startKst: "2026-10-22 05:00", endKst: "2026-10-29 04:59" },
    equal: true,
  }),
  expires_at: "2026-10-18T00:07:00Z",
};
const alert: OpsAlertRow = {
  alertKey: "manual-review:staging:naver-board-48:8289927",
  environment: "staging",
  severity: "warning",
  component: "source-queue",
  errorCode: "source_item_manual_review",
  state: "open",
  context: { reviewId: `mr-${"a".repeat(32)}`, title: "솔로 레이드 안내" },
  occurrenceCount: 1,
  lastSentOccurrenceCount: 0,
  firstSeenAt: row.judged_at,
  resolvedAt: null,
};

describe("manual review evidence cards", () => {
  it("prioritizes actions and comparison over oversized quotations", async () => {
    const evidence = {
      ...row,
      reason: "compensation_grant_date_missing",
      question: "질문".repeat(1000),
      block_excerpt: "인용".repeat(1000),
      comparison_json: JSON.stringify({
        blocking: false,
        known: {
          segments: [
            { segment: 1, kind: "old", startKst: "a", endKst: "b", rewardDays: ["2026-10-01"] },
          ],
        },
        segments: [
          { segment: 2, kind: "new", startKst: "c", endKst: "d", rewardDays: ["2026-10-02"] },
        ],
        grant: {
          grantGameDate: "2026-10-02",
          kits: [
            { law: "box-ii-v1", count: 3 },
            { law: "regular-box-v1", count: 2 },
          ],
          claimUntilKst: null,
          claimWindowAssumed: true,
        },
      }),
    };
    const fields = reviewEvidenceFields([evidence]);
    expect(fields[4]?.value).toContain("[일정 직접 확정]으로 지급일·수량 입력");
    expect(fields[3]?.value).toContain("기존 구간 → 제안 구간");
    expect(fields[3]?.value).toContain("보상 날짜 추가: 2026-10-02");
    expect(fields[3]?.value).toContain("보상 날짜 제거: 2026-10-01");
    expect(fields[3]?.value).toContain("게시 차단 여부: 차단 안 함");
    expect(fields[3]?.value).toContain("기한 미기재: 당일만 반영(보수적)");
    expect(fields[3]?.value).toContain("관리 키트 상자 II: 3개");
    expect(fields[3]?.value).toContain("관리 키트 상자: 2개");
    expect(fields[2]?.value).toContain("…(생략)");
  });
  it("renders equal 8289927-like periods and complete KST footer without timestamp", async () => {
    const message = await opsAlertMessage(alert);
    expect(message).not.toHaveProperty("components");
    expect(JSON.stringify(message)).not.toContain("forecast_manual_");
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(reviewEvidenceFields([row])[1]?.value).toContain(
      "-# 사유 코드: `ambiguous_schedule_change`",
    );
    expect(reviewEvidenceFields([row])[2]?.value).toBe(
      "> 솔로 레이드: 10월 22일 ~ 10월 29일\n> 솔로 레이드: 10월 22일 ~ 10월 29일",
    );
  });
  it.each([
    ["maintenance_missing", "board-48 업데이트 공지의 점검 일시"],
    ["maintenance_conflict", "board-48 업데이트 공지의 점검 일시"],
    ["maintenance_crosses_day", "board-48 업데이트 공지의 점검 일시"],
    ["reopen_unsupported", "재오픈/중단은 아직 자동 반영하지 않습니다."],
    ["suspension_unsupported", "재오픈/중단은 아직 자동 반영하지 않습니다."],
  ])("gives concrete guidance for %s", (reason, expected) => {
    expect(reviewEvidenceFields([{ ...row, reason }])[4]?.value).toContain(expected);
    expect(reviewEvidenceFields([{ ...row, reason }])[4]?.value).not.toContain("[일정 직접 확정]");
  });
  it.each([
    ["compensation_grant_date_ambiguous", "지급일의 연도"],
    ["compensation_claim_deadline_ambiguous", "수령 기한"],
  ])("explains grant date/deadline review %s with its code", (reason, expected) => {
    const fields = reviewEvidenceFields([{ ...row, reason }]);
    expect(fields[1]?.value).toContain(`-# 사유 코드: \`${reason}\``);
    expect(fields[4]?.value).toContain(expected);
    expect(fields[4]?.value).toContain("[일정 직접 확정]");
  });
  it("directs simple section schedule changes to direct confirmation", () => {
    expect(reviewEvidenceFields([{ ...row, reason: "schedule_change_in_section" }])[4]?.value).toBe(
      "솔로 레이드 항목에 연장·일정 변경 문구가 있습니다. 공지의 새 기간을 확인하고, 단순 연장/변경이면 [일정 직접 확정]으로 새 기간 입력, 반영할 필요가 없으면 [관련 없음].",
    );
  });
  it("neutralizes formatting and bounds every field and the aggregate", async () => {
    const text = "~~old~~ ||hidden|| `code` *bold* _italic_\n> @everyone <@123>";
    expect(escapeReviewText(text)).toBe(
      "\\~\\~old\\~\\~ \\|\\|hidden\\|\\| \\`code\\` \\*bold\\* \\_italic\\_\n＞ ＠everyone ＜＠123＞",
    );
    expect(escapeReviewText("a ~ b ~~~old~~~ \\*bold*")).toBe(
      "a ~ b \\~\\~\\~old\\~\\~\\~ \\\\\\*bold\\*",
    );
    const evidence = { ...row, question: text.repeat(1000), block_excerpt: text.repeat(1000) };
    const message = await opsAlertMessage(alert);
    const fields = reviewEvidenceFields([evidence, evidence, evidence]);
    expect(fields.every((field) => field.value.length <= 1024)).toBe(true);
    expect(fields[2]?.value).toContain("[옛 값(취소선): old]");
    expect(fields[2]?.value).toContain("…(생략)");
    expect(JSON.stringify(message).length).toBeLessThan(8500);
    expect(
      fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) + 700,
    ).toBeLessThanOrEqual(5500);
  });
  it.each(["unknown_code", "constructor", "__proto__", "`bad` @everyone"])(
    "omits a reason code outside the fixed allowlist: %s",
    (reason) => {
      const value = reviewEvidenceFields([{ ...row, reason }])[1]?.value;
      expect(value).not.toContain("사유 코드:");
      expect(value).not.toContain(reason);
    },
  );
  it("does not emit controls for persisted manual review alerts", async () => {
    expect(await opsAlertMessage(alert)).not.toHaveProperty("components");
  });
  it("renders literal collector columns and camelCase comparison including an unknown start time", () => {
    const evidence = {
      block_index: 0,
      judged_at: "2026-05-20T00:00:00Z",
      reason: "maintenance_missing",
      question: "점검 후 시작 시각은?",
      triggers_json: '["2026-05-28 점검 완료 후"]',
      block_excerpt: "~~*2026-05-21*~~ → 2026-05-28",
      comparison_json:
        '{"known":{"eventId":"solo-1","startsAt":"2026-05-28T01:00:00Z","endsAt":"2026-06-04T19:59:00Z","startKst":"2026-05-28 10:00","endKst":"2026-06-05 04:59"},"extracted":{"startsAt":null,"endsAt":"2026-06-04T19:59:00Z","startKst":"2026-05-28 점검 완료 후(시각 미확정)","endKst":"2026-06-05 04:59"},"equal":false}',
      expires_at: null,
    };
    const fields = reviewEvidenceFields([evidence]);
    expect(fields[3]?.value).toContain("기존: 2026-05-28 10:00 ~ 2026-06-05 04:59");
    expect(fields[3]?.value).toContain("추출: 2026-05-28 점검 완료 후(시각 미확정)");
    expect(fields[3]?.value).not.toContain("추출: 미확정");
    expect(fields[2]?.value).toContain("[옛 값(취소선): \\*2026-05-21\\*]");
    expect(fields[2]?.value).not.toContain("~");
  });
});
