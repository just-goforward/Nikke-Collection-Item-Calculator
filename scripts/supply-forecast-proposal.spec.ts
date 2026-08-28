import { describe, expect, it } from "vitest";
import { supplyForecastCandidateSchema } from "../shared/supplyForecastCandidate.ts";
import {
  formatForecastReviewForDiscord,
  parseForecastReviewMetadata,
  renderSupplyForecastProposal,
} from "./supply-forecast-proposal.ts";

const candidate = supplyForecastCandidateSchema.parse({
  payloadVersion: 3,
  candidateId: "forecast-proposal-12345678",
  forecastId: "supply-2026-08-28-v1",
  rulesVersion: "schedule-kit-v2",
  dispatchPolicyId: "dispatch-policy-v1",
  generatedAt: "2026-08-28T00:00:00.000Z",
  sourceStatus: "x_unavailable",
  schedule: {
    status: "estimated",
    cadenceDays: 28,
    soloStart: "2026-09-21T03:00:00.000Z",
    soloEnd: "2026-09-27T19:59:00.000Z",
    soloPeriods: [
      {
        effectiveFrom: "2026-01-01T03:00:00.000Z",
        effectiveUntil: "2026-01-07T19:59:00.000Z",
        scheduleStatus: "confirmed",
      },
      {
        effectiveFrom: "2026-02-01T03:00:00.000Z",
        effectiveUntil: "2026-02-07T19:59:00.000Z",
        scheduleStatus: "confirmed",
      },
      {
        effectiveFrom: "2026-09-21T03:00:00.000Z",
        effectiveUntil: "2026-09-27T19:59:00.000Z",
        scheduleStatus: "estimated",
      },
    ],
    collaborationPeriods: [
      {
        effectiveFrom: "2026-08-19T20:00:00.000Z",
        effectiveUntil: "2026-09-09T19:59:00.000Z",
      },
    ],
  },
  sourceEvidence: [
    {
      source: "naver-board-56",
      itemId: "1234",
      url: "https://game.naver.com/lounge/nikke/board/detail/1234",
      publishedAt: "2026-08-20T01:00:00.000Z",
      excerpt: "솔로 레이드 오픈 예정",
      contentHash: "a".repeat(64),
    },
  ],
  profiles: [
    profile("2026-08-31T20:00:00.000Z", "2026-09-01T20:00:00.000Z"),
    profile("2026-09-20T20:00:00.000Z", "2026-09-21T20:00:00.000Z"),
    profile("2026-09-22T20:00:00.000Z", "2026-09-23T20:00:00.000Z"),
  ],
  warnings: [],
});

describe("supply forecast proposal", () => {
  it("marks Solo Raid, collaboration, and Tuesday rewards in the profile table", () => {
    const body = renderSupplyForecastProposal(
      { payloadHash: "b".repeat(64), candidate },
      {
        status: "unavailable",
        source: "jina",
        reason: "rate_limited",
        statusUrl: null,
        excerpt: null,
      },
      {
        activeForecastId: "supply-fixed-v1",
        forecasts: [
          {
            id: "supply-fixed-v1",
            profiles: [{ expectedGain: { blue: 1, purple: 2, yellow: 3 } }],
          },
        ],
      },
    );

    expect(body).toContain("| 🟥 | 솔로 레이드 (예상)");
    expect(body).toContain("🟪 콜라보<br>🟨 화 05:00 · 상자 II ×10");
    expect(body).toContain("🟥 솔로 1일차");
    expect(body).toContain("🟥 솔로 3일차 · 전방 구간 전환");
    expect(body).toContain("게임 일자 (05:00 KST)");
  });

  it("embeds validated review metadata for the Discord card", () => {
    const body = renderSupplyForecastProposal(
      { payloadHash: "b".repeat(64), candidate },
      {
        status: "matching",
        source: "x-api",
        reason: "matched_schedule",
        statusUrl: "https://x.com/NIKKE_kr/status/123456789",
        excerpt: "솔로 레이드 일정",
      },
      { activeForecastId: "missing", forecasts: [] },
    );
    const metadata = parseForecastReviewMetadata(body);
    const discord = formatForecastReviewForDiscord(metadata);

    expect(metadata).toMatchObject({
      candidateId: candidate.candidateId,
      forecastId: candidate.forecastId,
      x: {
        status: "matching",
        source: "x-api",
        statusUrl: "https://x.com/NIKKE_kr/status/123456789",
      },
    });
    expect(discord.xLink).toBe("https://x.com/NIKKE_kr/status/123456789");
    expect(discord.content).toContain("솔로 레이드: 2026-09-21 12:00 KST");
    expect(discord.content).toContain("X 공지의 일정이 위 기간과 일치하는지 확인");
  });

  it("rejects edited or missing review metadata", () => {
    expect(() => parseForecastReviewMetadata("## Forecast approval")).toThrow(
      "metadata is missing",
    );
    expect(() => parseForecastReviewMetadata("<!-- forecast-review-v1:not-valid-json -->")).toThrow(
      "metadata is invalid",
    );
  });
});

function profile(effectiveFrom: string, effectiveUntil: string) {
  return {
    id: `${candidateIdPrefix()}@${effectiveFrom}`,
    effectiveFrom,
    effectiveUntil,
    scheduleStatus: "estimated" as const,
    expectedGain: { blue: 10, purple: 5, yellow: 2 },
  };
}

function candidateIdPrefix() {
  return "supply-2026-08-28-v1";
}
