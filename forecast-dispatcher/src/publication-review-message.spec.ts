import { describe, expect, it } from "vitest";
import type { ActiveRow, ReviewRow } from "../../shared/forecast-publication/store.ts";
import { fixtureCandidate, snapshot } from "./publication-review-fixtures.ts";
import {
  publicationReviewContent,
  type ReviewCandidateView,
  translateCandidateWarning,
} from "./publication-review-message.ts";

// Synthetic schema-shaped regression fixture; not a retrieved staging payload.
const NOW = Date.parse("2026-10-21T22:06:00.000Z");

const review = (over: Partial<ReviewRow> = {}): ReviewRow & { created_at: number } => ({
  created_at: NOW,
  review_id: "1c2f4d6a8b0e2f4a6c8d0e2f4a6c8d0e",
  environment: "staging",
  action: "approve",
  candidate_id: "forecast-5814579f4e4be1ceffd3025f",
  payload_hash: "641b555bc1f6594fb6b096418b9a2ff8beecaba933ea6d9fd09e2cd7fe478913",
  expected_sequence: 3,
  previous_candidate_id: "forecast-8d394501e121291efebaf687",
  expires_at: Date.parse("2026-10-22T20:52:59.241Z"),
  ...over,
});

const active: ActiveRow = {
  environment: "staging",
  sequence: 3,
  candidate_id: "forecast-8d394501e121291efebaf687",
  operation_id: "op-3",
  signed_pointer_json: null,
};

const rounds = (
  entries: [number, "confirmed" | "estimated", string, string][],
): NonNullable<ReviewCandidateView["certifiedSnapshot"]>["soloRounds"] =>
  entries.map(([round, status, startGameDate, endGameDate]) => ({
    round,
    status,
    startGameDate,
    endGameDate,
    sourceIds: [],
  }));

/** Regression facts supplied in the review brief, placed under the real schema. */
const activeCandidate: ReviewCandidateView = {
  ...fixtureCandidate,
  schedule: {
    ...fixtureCandidate.schedule,
    cadenceDays: 28,
    soloPeriods: [
      {
        scheduleStatus: "estimated",
        effectiveFrom: "2026-10-22T05:00:00+09:00",
        effectiveUntil: "2026-10-29T05:00:00+09:00",
        round: 42,
      },
      {
        scheduleStatus: "estimated",
        effectiveFrom: "2026-11-19T05:00:00+09:00",
        effectiveUntil: "2026-11-26T05:00:00+09:00",
        round: 43,
      },
    ],
    collaborationPeriods: [],
  },
  sourceEvidence: [
    {
      ...fixtureCandidate.sourceEvidence[0],
      source: "naver-board-56",
      itemId: "8207413",
      url: "https://game.naver.com/lounge/nikke/board/56/detail/8207413",
      publishedAt: "2026-10-01T00:00:00Z",
      excerpt: "fixture",
      contentHash: "a".repeat(64),
    },
  ],
  warnings: [],
  grants: [],
  certifiedSnapshot: {
    ...snapshot,
    soloRounds: rounds([
      [42, "estimated", "2026-10-22", "2026-10-29"],
      [43, "estimated", "2026-11-19", "2026-11-26"],
    ]),
    rules: [
      {
        id: "fixture-rule",
        collaborationShop: [],
        soloDays: [],
        provenance: [],
        dispatch: [{ lawId: "dispatch-board-v1", count: 1 }],
        normalShop: [
          { lawId: "regular-box-v1", count: 5 },
          { lawId: "box-ii-v1", count: 5 },
        ],
        weeklyFixed: [{ lawId: "deterministic:10,10,0", count: 1 }],
        effectiveFrom: "2026-10-01T05:00:00+09:00",
        effectiveUntil: null,
      },
    ],
    coverage: { ...snapshot.coverage, currentDay: "2026-10-19" },
  },
};

/** Round 42 confirmed, 43 moved, 44 added; these are not downloaded golden bytes. */
const candidate: ReviewCandidateView = {
  ...activeCandidate,
  schedule: {
    ...fixtureCandidate.schedule,
    cadenceDays: 28,
    soloPeriods: [
      {
        scheduleStatus: "confirmed",
        effectiveFrom: "2026-10-15T05:00:00+09:00",
        effectiveUntil: "2026-10-22T05:00:00+09:00",
        round: 42,
      },
      {
        scheduleStatus: "estimated",
        effectiveFrom: "2026-11-12T05:00:00+09:00",
        effectiveUntil: "2026-11-19T05:00:00+09:00",
        round: 43,
      },
      {
        scheduleStatus: "estimated",
        effectiveFrom: "2026-12-10T05:00:00+09:00",
        effectiveUntil: "2026-12-17T05:00:00+09:00",
        round: 44,
      },
    ],
    collaborationPeriods: [],
  },
  sourceEvidence: [
    {
      source: "naver-board-56",
      itemId: "8306665",
      url: "https://game.naver.com/lounge/nikke/board/56/detail/8306665",
      publishedAt: "2026-10-15T00:00:00Z",
      excerpt: "fixture",
      contentHash: "b".repeat(64),
    },
  ],
  warnings: [
    "New-round cadence could not be derived from the available history.",
    "X is advisory and is evaluated during proposal review.",
  ],
  certifiedSnapshot: {
    ...snapshot,
    rules: activeCandidate.certifiedSnapshot?.rules ?? [],
    soloRounds: rounds([
      [42, "confirmed", "2026-10-15", "2026-10-22"],
      [43, "estimated", "2026-11-12", "2026-11-19"],
      [44, "estimated", "2026-12-10", "2026-12-17"],
    ]),
    coverage: { ...snapshot.coverage, currentDay: "2026-10-22" },
  },
};

const competition = { counts: { approve: 3, rollback: 0, off: 1 }, todayCount: 1, newer: null };

describe("publication review message", () => {
  it("renders ledger round identities and exclusive end dates against the active candidate", () => {
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate,
      activeCandidate,
      competition,
      now: NOW,
    });
    expect(content).toContain(
      "· 라운드 42 변경: 10/22 05:00~10/29 04:59 KST (추정) → 10/15 05:00~10/22 04:59 KST (확정)\n" +
        "· 라운드 43 변경: 11/19 05:00~11/26 04:59 KST (추정) → 11/12 05:00~11/19 04:59 KST (추정)\n" +
        "· 라운드 44 추가: 12/10 05:00~12/17 04:59 KST (추정)",
    );
    expect(content).toContain("· 변경 없음: 지급·상점·주간 키트·파견·보상 구성 동일");
  });

  it("says the active state is off instead of inventing a comparison", () => {
    const content = publicationReviewContent({
      review: review(),
      active: { ...active, candidate_id: null, operation_id: null },
      candidate,
      activeCandidate: null,
      competition: { counts: { approve: 1, rollback: 0, off: 0 }, todayCount: 1, newer: null },
      now: NOW,
    });
    expect(content).toContain("· 지금은 예보가 끄기 상태입니다.");
    expect(content).toContain(
      "· 라운드: 42 10/15 05:00~10/22 04:59 KST (확정), 43 11/12 05:00~11/19 04:59 KST (추정), 44 12/10 05:00~12/17 04:59 KST (추정)",
    );
    expect(content).toContain("📊 지금 반영된 것: 없음(끄기 상태)");
    expect(content).toContain(
      "🔢 같은 차례(순번 3)에 대기 중인 요청이 이 메시지 포함 1건 있습니다: 승인 1.",
    );
  });

  it("renders rollback and off with their own consequence lines", () => {
    const rollback = publicationReviewContent({
      review: review({ action: "rollback" }),
      active,
      candidate,
      activeCandidate,
      competition,
      now: NOW,
    });
    expect(rollback).toContain("**Forecast 이전 후보로 되돌리기 확인** · 환경: staging");
    expect(rollback).toContain("📝 무슨 일이: 지금 반영된 예보를 이전에 승인한 후보로 되돌릴지");
    expect(rollback).toContain(
      "📌 반영하면 바뀌는 것: 사이트의 예보가 이전 승인본 내용으로 돌아갑니다.",
    );
    expect(rollback).not.toContain("라운드 42 변경");

    const off = publicationReviewContent({
      review: review({ action: "off", candidate_id: null, payload_hash: null }),
      active,
      candidate: null,
      activeCandidate,
      competition,
      now: NOW,
    });
    expect(off).toContain("**Forecast 예보 끄기 확인** · 환경: staging");
    expect(off).toContain("📌 반영하면 바뀌는 것: 사이트에서 예보가 내려가고 끄기 상태가 됩니다.");
    expect(off).not.toContain("근거 공지");
    expect(off).toContain("기록용: 후보 off · 검토");
  });
});

describe("publication review comparison safety", () => {
  it("never uses the failure marker for a normal request", () => {
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate,
      activeCandidate,
      competition,
      now: NOW,
    });
    expect(content).not.toContain("❌");
    expect(content).toContain("📝 무슨 일이:");
  });

  it("does not treat an unreadable active candidate as off or as the candidate itself", () => {
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate,
      activeCandidate: null,
      competition,
      now: NOW,
    });
    expect(content).toContain("현재 반영본을 읽을 수 없어 비교할 수 없습니다.");
    expect(content).not.toContain("지금은 예보가 끄기 상태");
    expect(content).not.toContain("구성 동일");
    expect(content).toContain("42 10/15 05:00~10/22 04:59 KST (확정)");
  });

  it("detects a real nested shop quantity change even when round dates match", () => {
    const baseline = candidate.certifiedSnapshot;
    if (!baseline) throw new Error("snapshot_fixture_missing");
    const changed = {
      ...candidate,
      certifiedSnapshot: {
        ...baseline,
        rules: baseline.rules.map((rule) => ({
          ...rule,
          normalShop: rule.normalShop.map((ref) => ({
            ...ref,
            count: ref.lawId === "regular-box-v1" ? 6 : ref.count,
          })),
        })),
      },
    };
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate: changed,
      activeCandidate: candidate,
      competition,
      now: NOW,
    });
    expect(content).toContain(
      "상점(주당) 변경: 상자 II 5개, 일반 상자 5개 → 상자 II 5개, 일반 상자 6개",
    );
    expect(content).not.toContain("구성 동일");
  });

  it("compares grant contents even when their count is unchanged", () => {
    const grant = {
      id: "grant-1",
      grantGameDate: "2026-10-22",
      refs: [{ lawId: "regular-box-v1", count: 5 }],
      claimWindowAssumed: true,
      sourceIds: [],
      restatementOf: [],
    };
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate: {
        ...candidate,
        grants: [{ ...grant, refs: [{ lawId: "regular-box-v1", count: 6 }] }],
      },
      activeCandidate: { ...candidate, grants: [grant] },
      competition,
      now: NOW,
    });
    expect(content).toContain("지급 내용·수령 기간 변경");
    expect(content).not.toContain("구성 동일");
  });

  it("names a newer request relative to this message's own creation time", () => {
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate,
      activeCandidate,
      now: NOW,
      competition: {
        ...competition,
        newer: { action: "approve", createdAt: NOW + 60_000, candidateId: "forecast-newer" },
      },
    });
    expect(content).toContain("더 최근 요청 있음: 승인(후보 forecast-newer, 10/22(목) 07:07 KST)");
    expect(content).not.toContain("이 메시지가 가장 최근");
  });

  it("states which competing candidates target the game day in progress", () => {
    const withToday = publicationReviewContent({
      review: review(),
      active,
      candidate,
      activeCandidate,
      competition: { ...competition, todayCount: 2 },
      now: NOW,
    });
    expect(withToday).toContain("기준 게임일이 오늘(2026-10-22)인 후보 요청은 2건입니다.");

    const noneToday = publicationReviewContent({
      review: review(),
      active,
      candidate: {
        ...candidate,
        certifiedSnapshot: {
          ...snapshot,
          coverage: { ...snapshot.coverage, currentDay: "2026-10-21" },
        },
      },
      activeCandidate,
      competition: { ...competition, todayCount: 0 },
      now: NOW,
    });
    expect(noneToday).toContain("기준 게임일이 오늘(2026-10-22)인 후보 요청은 0건입니다.");
  });

  it("translates known warnings and keeps an unknown one verbatim", () => {
    expect(translateCandidateWarning("Official sources report conflicting schedules.")).toBe(
      "공식 출처 간 일정이 서로 다릅니다.",
    );
    expect(translateCandidateWarning("Some new upstream warning.")).toBe(
      "Some new upstream warning.",
    );
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate: { ...candidate, warnings: ["Some new upstream warning."] },
      activeCandidate,
      competition,
      now: NOW,
    });
    expect(content).toContain("⚠️ 후보 경고: Some new upstream warning.");
  });

  it("omits the warning line when the candidate has none", () => {
    const content = publicationReviewContent({
      review: review(),
      active,
      candidate: { ...candidate, warnings: [] },
      activeCandidate,
      competition,
      now: NOW,
    });
    expect(content).not.toContain("후보 경고");
    expect(content).not.toContain("none");
  });
});
