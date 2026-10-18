import { expect, it } from "vitest";
import { reviewExcluded } from "./publication-exclusions";
import type { Judgment } from "./solo-contracts";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

const item: NormalizedSourceItem = {
  source: "naver-board-11",
  itemId: "1",
  url: "https://game.naver.com/lounge/nikke/board/detail/1",
  title: "보상",
  excerpt: "보상",
  normalizedText: "보상",
  publishedAt: "2026-06-23T00:00:00Z",
  contentHash: "a".repeat(64),
  official: true,
  structured: true,
};
const judgment = (): Judgment => ({
  blockIndex: 0,
  verdict: "manual_review",
  reason: "compensation_restatement_ambiguous",
  question: "date?",
  triggers: [],
  blockExcerpt: "6/23 지급 보상",
  maintenanceInputs: [],
  comparison: {
    known: null,
    extracted: null,
    equal: false,
    blocking: true,
    grant: {
      grantGameDate: "2026-06-23",
      kits: [{ law: "box-ii-v1", count: 56 }],
      claimUntilKst: null,
      claimWindowAssumed: true,
    },
  },
});
it("keeps a persisted negative first evaluation blocked after the horizon moves", async () => {
  const review = {
    item,
    judgments: [judgment()],
    publicationBinding: { reviewId: "test", contextHash: "test" },
  };
  expect(
    await reviewExcluded(review, [], [], { from: "2026-06-22", until: "2026-06-24" }, true),
  ).toBe(false);
  const persisted = JSON.parse(JSON.stringify(review));
  expect(persisted.evaluations[0]).toBeNull();
  expect(
    await reviewExcluded(persisted, [], [], { from: "2026-06-25", until: "2026-06-30" }, true),
  ).toBe(false);
});
it.each(["interval", "status"] as const)(
  "invalidates modeled reopen exclusion on changed %s",
  async (change) => {
    const entry = judgment();
    delete entry.comparison.grant;
    entry.reason = "reopen_without_suspension";
    entry.comparison.extracted = {
      startsAt: "2026-06-20T00:00:00Z",
      endsAt: "2026-06-23T00:00:00Z",
      startKst: null,
      endKst: null,
    };
    const event: ScheduleEvent = {
      eventId: "reopen",
      eventType: "solo",
      sourceItem: item,
      startsAt: entry.comparison.extracted.startsAt,
      endsAt: entry.comparison.extracted.endsAt,
      scheduleStatus: "confirmed",
      manualReview: false,
      reason: null,
      segment: {
        round: 1,
        segment: 2,
        kind: "reopen",
        effectiveFrom: "2026-06-20T00:00:00Z",
        effectiveUntil: "2026-06-23T00:00:00Z",
      },
    };
    const review = { item, judgments: [entry] };
    const horizon = { from: "2026-08-01T00:00:00Z", until: "2026-10-01T00:00:00Z" };
    expect(await reviewExcluded(review, [event], [], horizon, true)).toBe(true);
    expect(
      await reviewExcluded(
        review,
        [event],
        [],
        {
          from: "2026-08-02T00:00:00Z",
          until: "2026-10-02T00:00:00Z",
        },
        false,
      ),
    ).toBe(true);
    if (change === "interval") {
      event.endsAt = "2026-06-24T00:00:00Z";
      entry.comparison.extracted.endsAt = event.endsAt;
    } else event.scheduleStatus = "estimated";
    expect(await reviewExcluded(review, [event], [], horizon, false)).toBe(false);
  },
);
it("recomputes the horizon and never excludes a previously excluded grant when relevant", async () => {
  const review = { item, judgments: [judgment()] };
  const later = { from: "2026-08-01T00:00:00Z", until: "2026-10-01T00:00:00Z" };
  expect(await reviewExcluded(review, [], [], later, true)).toBe(true);
  expect(await reviewExcluded(review, [], [], later, false)).toBe(true);
  expect(
    await reviewExcluded(
      review,
      [],
      [],
      {
        from: "2026-08-02T00:00:00Z",
        until: "2026-10-02T00:00:00Z",
      },
      false,
    ),
  ).toBe(true);
  expect(
    await reviewExcluded(
      review,
      [],
      [],
      {
        from: "2026-06-01T00:00:00Z",
        until: "2026-08-01T00:00:00Z",
      },
      false,
    ),
  ).toBe(false);
});
it("retains an exclusion when unrelated supply semantics change", async () => {
  const review = { item, judgments: [judgment()] };
  const horizon = { from: "2026-08-01T00:00:00Z", until: "2026-10-01T00:00:00Z" };
  expect(await reviewExcluded(review, [], [], horizon, true)).toBe(true);
  expect(
    await reviewExcluded(
      review,
      [],
      [
        {
          id: "grant:naver-board-11:2:2026-08-02:1",
          grantGameDate: "2026-08-02",
          refs: [{ lawId: "box-ii-v1", count: 1 }],
          claimWindowAssumed: true,
          sourceIds: [item.url],
          restatementOf: [],
        },
      ],
      horizon,
      false,
    ),
  ).toBe(true);
});
it("blocks unknown manual evidence without a typed rule", async () => {
  const unknown = judgment();
  delete unknown.comparison.grant;
  expect(
    await reviewExcluded(
      { item, judgments: [unknown] },
      [],
      [],
      {
        from: "2026-08-01T00:00:00Z",
        until: "2026-10-01T00:00:00Z",
      },
      true,
    ),
  ).toBe(false);
});

it("excludes only a complete, explicitly museum-only section", async () => {
  const museum = judgment();
  delete museum.comparison.grant;
  museum.reason = "ambiguous_schedule_change";
  museum.blockExcerpt = "1. 솔로 레이드 박물관\n과거 기록을 전시합니다.";
  const horizon = { from: "2026-08-01T00:00:00Z", until: "2026-10-01T00:00:00Z" };
  expect(await reviewExcluded({ item, judgments: [museum] }, [], [], horizon, true)).toBe(true);
  expect(
    await reviewExcluded(
      { item, judgments: [museum] },
      [],
      [],
      {
        from: "2026-08-02T00:00:00Z",
        until: "2026-10-02T00:00:00Z",
      },
      false,
    ),
  ).toBe(true);
  museum.blockExcerpt = "1. 솔로 레이드 박물관\n" + "기록".repeat(600);
  expect(await reviewExcluded({ item, judgments: [museum] }, [], [], horizon, false)).toBe(false);
});
