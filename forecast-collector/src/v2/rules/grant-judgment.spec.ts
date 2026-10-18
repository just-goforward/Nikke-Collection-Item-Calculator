import { expect, it } from "vitest";
import { judgeGrant } from "./grant-judgment";

it("requires all-account distribution and applies the midnight game day", () => {
  const post = {
    title: "보상",
    postedAt: "2026-06-25T17:00:00+09:00",
    body: "전체 지휘관 우편 보상\n보상 지급일: 6/26 00:00\n관리 키트 상자 Ⅱ ×10\n관리 키트 상자 ×5",
  };
  expect(judgeGrant(post, [])).toMatchObject({
    action: "grant",
    gameDay: "2026-06-25",
    ii: 10,
    box: 5,
  });
  expect(judgeGrant({ ...post, body: "이벤트 미션 관리 키트 상자 II ×10" }, [])).toEqual({
    action: "ignore",
  });
});

it("preserves explicit date-only payment precision without inventing an instant", () => {
  expect(
    judgeGrant(
      {
        title: "보상",
        postedAt: "2026-06-22T17:00:00+09:00",
        body: "전체 지휘관 우편 보상\n보상 지급일: 6/23\n관리 키트 상자 II ×10",
      },
      [],
    ),
  ).toMatchObject({
    action: "grant",
    gameDay: "2026-06-23",
    instant: null,
    basis: "explicit_payment",
  });
});
