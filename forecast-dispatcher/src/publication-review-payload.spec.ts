import { describe, expect, it } from "vitest";
import type { ActiveRow, ReviewRow } from "../../shared/forecast-publication/store.ts";
import { fixtureCandidate, snapshot } from "./publication-review-fixtures.ts";
import {
  publicationButtonLabel,
  publicationResultContent,
  publicationReviewContent,
  publicationReviewPayload,
  type ReviewCandidateView,
} from "./publication-review-message.ts";

const NOW = Date.parse("2026-10-21T23:52:59.241Z");
const review = (over: Partial<ReviewRow> = {}): ReviewRow & { created_at: number } => ({
  created_at: NOW,
  review_id: "5f1c0f2a9d8e4b7a6c3d2e1f0a9b8c7d",
  environment: "staging",
  action: "approve",
  candidate_id: "forecast-5814579f4e4be1ceffd3025f",
  payload_hash: "641b555bc1f6594fb6b096418b9a2ff8beecaba933ea6d9fd09e2cd7fe478913",
  expected_sequence: 3,
  previous_candidate_id: null,
  expires_at: Date.parse("2026-10-22T20:52:59.241Z"),
  ...over,
});
const active: ActiveRow = {
  environment: "staging",
  sequence: 3,
  candidate_id: null,
  operation_id: null,
  signed_pointer_json: null,
};
const candidate = (over: Partial<ReviewCandidateView> = {}): ReviewCandidateView => ({
  ...fixtureCandidate,
  schedule: {
    ...fixtureCandidate.schedule,
    cadenceDays: 28,
    soloPeriods: [
      {
        scheduleStatus: "confirmed",
        effectiveFrom: "2026-10-15T05:00:00+09:00",
        effectiveUntil: "2026-10-22T05:00:00+09:00",
      },
    ],
    collaborationPeriods: [],
  },
  sourceEvidence: fixtureCandidate.sourceEvidence,
  warnings: [],
  certifiedSnapshot: { ...snapshot, coverage: { ...snapshot.coverage, currentDay: "2026-10-22" } },
  ...over,
});
const input = (over: Partial<Parameters<typeof publicationReviewContent>[0]> = {}) => ({
  review: review(),
  active,
  candidate: candidate(),
  activeCandidate: null,
  competition: { counts: { approve: 1, rollback: 0, off: 0 }, todayCount: 1, newer: null },
  now: NOW,
  ...over,
});

describe("publication review payload", () => {
  it("keeps the parsed button custom_id and switches only the label", () => {
    const button = publicationReviewPayload(input()).components[0]?.components[0];
    if (!button) throw new Error("button_fixture_missing");
    expect(button.custom_id).toBe("forecast_publish:staging:5f1c0f2a9d8e4b7a6c3d2e1f0a9b8c7d");
    expect(button.label).toBe("승인 (staging)");
    expect(button.style).toBe(3);
    expect(
      publicationReviewPayload(
        input({
          review: review({ action: "off", candidate_id: null, payload_hash: null }),
          candidate: null,
        }),
      ).components[0]?.components[0]?.style,
    ).toBe(4);
    expect(publicationButtonLabel("rollback", "staging")).toBe("롤백 (staging)");
  });

  it("keeps the action and consequence lines while truncating long detail", () => {
    const manySources = Array.from({ length: 40 }, (_, index) => ({
      source: "naver-board-56" as const,
      itemId: `${"9".repeat(150)}-${index}`,
      url: `https://game.naver.com/lounge/nikke/board/56/detail/${"1".repeat(150)}-${index}`,
      publishedAt: "2026-10-15T00:00:00Z",
      excerpt: "fixture",
      contentHash: "a".repeat(64),
    }));
    const content = publicationReviewContent(
      input({
        candidate: candidate({
          sourceEvidence: manySources,
          warnings: Array.from({ length: 20 }, () => "X".repeat(300)),
        }),
        competition: {
          counts: { approve: 2, rollback: 0, off: 0 },
          todayCount: 2,
          newer: {
            action: "approve",
            createdAt: NOW + 1_000,
            candidateId: "forecast-2f94cb74c1a2b3d4e5f60718293a4b5c",
          },
        },
      }),
    );
    expect(content.length).toBeLessThanOrEqual(2000);
    // Essential guidance survives; only optional blocks were dropped.
    expect(content).toContain("**Forecast 예보 반영 승인 요청**");
    expect(content).toContain("📝 무슨 일이:");
    expect(content).toContain("📌 반영하면 바뀌는 것");
    expect(content).toContain("🕔 그대로 두면:");
    expect(content).toContain("👉 해 주실 일:");
    expect(content).toContain("기록용: 후보 forecast-5814579f4e4be1ceffd3025f");
  });

  it("renders the committed-result follow-up in Korean", () => {
    expect(
      publicationResultContent({
        environment: "staging",
        action: "approve",
        sequence: 4,
        candidate_id: "forecast-5814579f4e4be1ceffd3025f",
        operationId: "1201",
      }),
    ).toBe(
      [
        "**Forecast 승인 반영 완료** · 환경: staging",
        "✅ 처리 결과: 이 작업은 사이트 예보를 후보 forecast-5814579f4e4be1ceffd3025f 내용으로 반영했습니다.",
        "📊 처리 당시 순번: 4 (이후 다른 작업으로 상태가 바뀌었을 수 있습니다)",
        "👉 해 주실 일: 할 일 없음. 이 알림은 기록용이며, 되돌릴 때는 새 검토 메시지의 버튼을 사용하세요.",
        "기록용: 후보 forecast-5814579f4e4be1ceffd3025f · 시퀀스 4 · 작업 1201",
      ].join("\n"),
    );
    expect(
      publicationResultContent({
        environment: "staging",
        action: "off",
        sequence: 5,
        candidate_id: null,
        operationId: "1202",
      }),
    ).toContain("✅ 처리 결과: 이 작업은 사이트 예보를 끄기로 처리했습니다.");
  });
});

describe("essential publication content budget", () => {
  it("summarizes a long off-baseline reward list with an exact omitted-kind count", () => {
    const law = snapshot.laws[0];
    if (!law) throw new Error("law_fixture_missing");
    const content = publicationReviewContent(
      input({
        candidate: candidate({
          certifiedSnapshot: {
            ...snapshot,
            laws: Array.from({ length: 200 }, (_, index) => ({
              ...law,
              id: `reward-${index}-${"x".repeat(80)}`,
            })),
          },
        }),
      }),
    );
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain(`reward-0-${"x".repeat(80)}`);
    expect(content).toContain("외 199종");
    expect(content).not.toContain("reward-199-");
    expect(content).toContain("지금은 예보가 끄기 상태입니다.");
    expect(content).toContain("🕔 그대로 두면:");
    expect(content).toContain("👉 해 주실 일:");
    expect(content).toContain("기록용: 후보 forecast-5814579f4e4be1ceffd3025f");
  });

  it("hard-caps oversized essential detail while retaining expiry, action and record blocks", () => {
    const round = snapshot.soloRounds[0];
    if (!round) throw new Error("round_fixture_missing");
    const expanded = candidate({
      certifiedSnapshot: {
        ...snapshot,
        soloRounds: Array.from({ length: 500 }, (_, index) => ({ ...round, round: index * 2 + 1 })),
      },
    });
    const content = publicationReviewContent(
      input({
        active: { ...active, candidate_id: expanded.candidateId },
        activeCandidate: expanded,
        candidate: expanded,
      }),
    );
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("… (세부 내용 생략)");
    expect(content).toContain("**Forecast 예보 반영 승인 요청**");
    expect(content).toContain("📝 무슨 일이:");
    expect(content).toContain("📌 반영하면 바뀌는 것");
    expect(content).toContain("🕔 그대로 두면:");
    expect(content).toContain("👉 해 주실 일:");
    expect(content).toContain("기록용: 후보 forecast-5814579f4e4be1ceffd3025f");
  });
});
