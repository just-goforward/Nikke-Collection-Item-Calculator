import { expect, it } from "vitest";
import { judgeCollaboration } from "./collaboration";

it("resolves date-only starts through G and never infers a time without G", () => {
  const post = {
    title: "콜라보",
    body: "7/3(금) 콜라보 진행 결정",
    postedAt: "2026-06-26T17:00:00+09:00",
  };
  expect(judgeCollaboration(post, [], [])).toMatchObject({ action: "decision" });
  expect(
    judgeCollaboration(
      post,
      [
        {
          id: "m",
          startAt: "2026-07-03T05:00:00+09:00",
          endAt: "2026-07-03T12:00:00+09:00",
        },
      ],
      [],
    ),
  ).toEqual({
    action: "create",
    startAt: "2026-07-03T12:00:00+09:00",
    endAt: "2026-07-30T19:59:59.000Z",
    maintenanceEventId: "m",
  });
});

it("holds the literal 7660727 archive-addition wording for U22 review", () => {
  expect(
    judgeCollaboration(
      {
        title: "📢 아카이브 추가 안내 - 「MEMORIES TELLER」",
        body: "5/14(목) 점검 완료 후, 스토리 이벤트\n[MEMORIES TELLER]가 아카이브에 추가됩니다.",
        postedAt: "2026-05-13T19:00:31+09:00",
      },
      [],
      [],
    ),
  ).toEqual({ action: "decision", reason: "archive_readdition", candidates: [] });
});
